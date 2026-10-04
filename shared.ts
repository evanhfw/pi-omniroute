import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ─── Local CLI interface — no import from either CLI package ──────────────────
interface OmniPI {
	registerProvider(name: string, config: any): void;
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: any;
		execute(id: string, params: any, signal?: AbortSignal, onUpdate?: (p: any) => void, ctx?: any): Promise<any>;
	}): void;
	registerCommand(
		name: string,
		opts: {
			description: string;
			getArgumentCompletions?(prefix: string): { value: string; label: string }[];
			handler(args: string, ctx: any): Promise<void>;
		},
	): void;
	on(event: string, handler: (event: any, ctx: any) => any): void;
}

// ─── Public export ────────────────────────────────────────────────────────────
export interface AgentHomeOptions {
	homeEnvVar: string;
	defaultHome: string;
}

// ─── Internal types ───────────────────────────────────────────────────────────
type RoutingMode = "default" | "fast" | "balanced" | "quality" | "cheap" | "reliable" | "offline";
type BudgetFallback = "cheapest" | "strict";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

/** Per-model metadata patches for fields the endpoint omits (keyed by exact model id). */
type ModelOverride = {
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
};

interface OmniConfig {
	serverUrl: string;
	apiKey: string;
	providerName: string;
	routingMode: RoutingMode;
	budgetUsd?: number;
	budgetFallback: BudgetFallback;
	compression: string;
	modelOverrides?: Record<string, ModelOverride>;
	/** Allowlist of endpoint model ids to register; omitted = register all. */
	selectedModels?: string[];
}

interface RouteTelemetry {
	status: number;
	requestId?: string;
	model?: string;
	provider?: string;
	decision?: string;
	latencyMs?: string;
	costUsd?: string;
	tokensIn?: string;
	tokensOut?: string;
	cacheHit?: string;
	fallbackAttempts?: string;
	compression?: string;
	version?: string;
	receivedAt: number;
}

interface OmniApiModel {
	id?: string;
	name?: string;
	owned_by?: string;
	context_length?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	max_tokens?: number;
	reasoning?: boolean;
	capabilities?: { reasoning?: boolean; thinking?: boolean; effort_tiers?: unknown };
	effort_tiers?: unknown;
	input_modalities?: unknown;
	input?: unknown;
	output_modalities?: unknown;
	output?: unknown;
	type?: string;
	provider?: string;
}

type SyncedModel = {
	id: string;
	name: string;
	owned_by?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: string[];
	thinkingLevelMap?: ThinkingLevelMap;
};

type ProviderModelConfig = {
	id: string;
	name: string;
	api: string;
	reasoning: boolean;
	input: string[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: ThinkingLevelMap;
};

// ─── Constants ────────────────────────────────────────────────────────────────
const PROVIDER_API = "openai-completions";
const AUTO_MODELS = ["auto", "auto/coding", "auto/fast", "auto/cheap", "auto/offline", "auto/smart", "auto/lkgp"];
const EXTENSION_STATE_DIR = "omniroute-agent-extension";
const ROUTING_MODES: RoutingMode[] = ["default", "fast", "balanced", "quality", "cheap", "reliable", "offline"];
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_CONFIG: OmniConfig = {
	serverUrl: "http://127.0.0.1:20128",
	apiKey: "",
	providerName: "omni",
	routingMode: "default",
	budgetFallback: "cheapest",
	compression: "default",
};

// ─── Path helpers ─────────────────────────────────────────────────────────────
function resolveAgentHome(opts: AgentHomeOptions): string {
	const env = process.env[opts.homeEnvVar];
	if (env) return env;
	const parts = opts.defaultHome.replace(/^~\//, "").split("/");
	return join(homedir(), ...parts);
}

function configPath(agentHome: string): string {
	return join(agentHome, EXTENSION_STATE_DIR, "config.json");
}

function modelsJsonPath(agentHome: string): string {
	return join(agentHome, "models.json");
}

// ─── Config I/O ───────────────────────────────────────────────────────────────
function normalizeServerUrl(value: string): string {
	let url = value.trim().replace(/\/+$/, "");
	if (url.endsWith("/v1")) url = url.slice(0, -3);
	return url || DEFAULT_CONFIG.serverUrl;
}

function sanitizeModelOverrides(value: unknown): Record<string, ModelOverride> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const out: Record<string, ModelOverride> = {};
	for (const [id, raw] of Object.entries(value as Record<string, any>)) {
		if (!id || !raw || typeof raw !== "object") continue;
		const override: ModelOverride = {};
		if (typeof raw.name === "string") override.name = raw.name;
		if (typeof raw.reasoning === "boolean") override.reasoning = raw.reasoning;
		const input = normalizeModalities(raw.input);
		if (input.length > 0) override.input = input;
		if (Number.isFinite(raw.contextWindow) && raw.contextWindow > 0) override.contextWindow = Number(raw.contextWindow);
		if (Number.isFinite(raw.maxTokens) && raw.maxTokens > 0) override.maxTokens = Number(raw.maxTokens);
		if (raw.thinkingLevelMap && typeof raw.thinkingLevelMap === "object") {
			const map: ThinkingLevelMap = {};
			for (const level of THINKING_LEVELS) {
				const mapped = (raw.thinkingLevelMap as Record<string, unknown>)[level];
				if (typeof mapped === "string") map[level] = mapped;
				else if (mapped === null) map[level] = null;
			}
			if (Object.keys(map).length > 0) override.thinkingLevelMap = map;
		}
		if (Object.keys(override).length > 0) out[id] = override;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeSelectedModels(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out = value.map((v) => String(v).trim()).filter(Boolean);
	return Array.from(new Set(out));
}

function sanitizeConfig(input: Partial<OmniConfig>): OmniConfig {
	const rawMode = String(input.routingMode ?? DEFAULT_CONFIG.routingMode).toLowerCase() as RoutingMode;
	const rawBudget = Number(input.budgetUsd);
	const rawFallback = String(input.budgetFallback ?? DEFAULT_CONFIG.budgetFallback).toLowerCase();
	const modelOverrides = sanitizeModelOverrides(input.modelOverrides);
	const selectedModels = sanitizeSelectedModels(input.selectedModels);
	return {
		serverUrl: normalizeServerUrl(String(input.serverUrl || DEFAULT_CONFIG.serverUrl)),
		apiKey: String(input.apiKey ?? ""),
		providerName: String(input.providerName || DEFAULT_CONFIG.providerName).trim() || DEFAULT_CONFIG.providerName,
		routingMode: ROUTING_MODES.includes(rawMode) ? rawMode : DEFAULT_CONFIG.routingMode,
		...(Number.isFinite(rawBudget) && rawBudget > 0 ? { budgetUsd: rawBudget } : {}),
		budgetFallback: rawFallback === "strict" ? "strict" : "cheapest",
		compression: String(input.compression ?? DEFAULT_CONFIG.compression).trim() || DEFAULT_CONFIG.compression,
		...(modelOverrides ? { modelOverrides } : {}),
		...(selectedModels ? { selectedModels } : {}),
	};
}

function loadConfig(agentHome: string): OmniConfig {
	const env: Partial<OmniConfig> = {};
	if (process.env.OMNIROUTE_URL) env.serverUrl = process.env.OMNIROUTE_URL;
	if (process.env.OMNIROUTE_API_KEY) env.apiKey = process.env.OMNIROUTE_API_KEY;
	if (process.env.OMNIROUTE_PROVIDER_NAME) env.providerName = process.env.OMNIROUTE_PROVIDER_NAME;
	if (process.env.OMNIROUTE_MODE) env.routingMode = process.env.OMNIROUTE_MODE as RoutingMode;
	if (process.env.OMNIROUTE_BUDGET) env.budgetUsd = Number(process.env.OMNIROUTE_BUDGET);
	if (process.env.OMNIROUTE_BUDGET_FALLBACK) env.budgetFallback = process.env.OMNIROUTE_BUDGET_FALLBACK as BudgetFallback;
	if (process.env.OMNIROUTE_COMPRESSION) env.compression = process.env.OMNIROUTE_COMPRESSION;
	try {
		return sanitizeConfig({ ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(configPath(agentHome), "utf8")), ...env });
	} catch {
		return sanitizeConfig({ ...DEFAULT_CONFIG, ...env });
	}
}

function saveConfig(agentHome: string, config: OmniConfig): void {
	const path = configPath(agentHome);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(sanitizeConfig(config), null, 2));
}

function readModelsJson(agentHome: string): any {
	try {
		return JSON.parse(readFileSync(modelsJsonPath(agentHome), "utf8"));
	} catch {
		return {};
	}
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────
function authHeaders(config: OmniConfig): Record<string, string> {
	return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
}

async function requestJson(config: OmniConfig, path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<any> {
	const res = await fetch(`${config.serverUrl}${path}`, {
		...init,
		headers: { "Content-Type": "application/json", ...authHeaders(config), ...(init.headers ?? {}) },
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	if (!res.ok) throw Object.assign(new Error(`${res.status}: ${text || res.statusText}`), { status: res.status });
	return text ? JSON.parse(text) : {};
}

async function checkHealth(config: OmniConfig): Promise<boolean> {
	try {
		const res = await fetch(`${config.serverUrl}/v1/models`, {
			headers: authHeaders(config),
			signal: AbortSignal.timeout(3_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

interface SearchParams {
	query: string;
	max_results?: number;
	provider?: string;
	search_type?: "web" | "news";
}

async function webSearch(config: OmniConfig, params: SearchParams): Promise<any> {
	const body: Record<string, unknown> = { query: params.query };
	if (params.max_results) body.max_results = params.max_results;
	if (params.provider) body.provider = params.provider;
	if (params.search_type && params.search_type !== "web") body.search_type = params.search_type;
	return requestJson(config, "/v1/search", { method: "POST", body: JSON.stringify(body) }, 15_000);
}

function formatSearchResults(data: any): string {
	const items: any[] = Array.isArray(data?.results) ? data.results : [];
	if (items.length === 0) return "No results.";
	return [`Search: ${data.query ?? ""}`, `Provider: ${data.provider ?? "?"}`, ""].concat(
		items.map((r, i) => {
			const cite = r.citation?.provider ? ` [${r.citation.provider}]` : "";
			const meta = r.published_at ? ` (${r.published_at})` : "";
			return `${i + 1}. ${r.title ?? ""}${meta}\n   ${r.url ?? ""}\n   ${r.snippet ?? ""}${cite}`;
		}),
	).join("\n");
}

// ─── Model utilities ──────────────────────────────────────────────────────────
function normalizeModalities(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const normalized = String(item).trim().toLowerCase();
		if ((normalized === "text" || normalized === "image") && !out.includes(normalized)) out.push(normalized);
	}
	return out;
}

function normalizeEffortTiers(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		const tier = String(item).trim().toLowerCase();
		if (tier && !out.includes(tier)) out.push(tier);
	}
	return out;
}

/** Map endpoint effort tiers onto Pi thinking levels; unsupported levels are hidden (null). */
function buildThinkingLevelMap(tiers: string[]): ThinkingLevelMap | undefined {
	if (tiers.length === 0) return undefined;
	const map: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) {
		if (level === "off") continue;
		map[level] = tiers.includes(level) ? level : null;
	}
	return map;
}

function isPiChatModel(model: OmniApiModel): boolean {
	const output = normalizeModalities(model.output_modalities ?? model.output);
	if (String(model.type || "chat").toLowerCase() === "image") return false;
	return output.length === 0 || output.includes("text");
}

function upsertSyncedModel(models: SyncedModel[], next: SyncedModel): void {
	const index = models.findIndex((m) => m.id === next.id);
	if (index < 0) {
		models.push(next);
		return;
	}
	const existing = models[index];
	const input = Array.from(new Set([...(existing.input ?? []), ...(next.input ?? [])]));
	models[index] = {
		...existing,
		...next,
		input: input.length > 0 ? input : existing.input,
		contextWindow: next.contextWindow ?? existing.contextWindow,
		maxTokens: next.maxTokens ?? existing.maxTokens,
		reasoning: existing.reasoning || next.reasoning,
		thinkingLevelMap: next.thinkingLevelMap ?? existing.thinkingLevelMap,
	};
}

function sortKey(id: string): string {
	const autoIdx = AUTO_MODELS.indexOf(id);
	if (autoIdx >= 0) return `0:${String(autoIdx).padStart(3, "0")}`;
	return `1:${id}`;
}

// ─── Sync + persistence ───────────────────────────────────────────────────────
async function fetchSyncedModels(config: OmniConfig): Promise<SyncedModel[]> {
	const data = await requestJson(config, "/v1/models");
	const rawModels: any[] = Array.isArray(data?.data) ? data.data : [];
	const results: SyncedModel[] = [];

	for (const m of rawModels) {
		const id = typeof m === "string" ? m : m?.id;
		if (!id || !isPiChatModel(m)) continue;

		const synced: SyncedModel = { id, name: m.name ?? id, owned_by: m.owned_by };

		const input = normalizeModalities(m.input_modalities ?? m.input);
		synced.input = input.length > 0 ? input : ["text"];

		const contextWindow = m.context_length || m.max_input_tokens;
		if (contextWindow) synced.contextWindow = contextWindow;

		const maxTokens = m.max_output_tokens || m.max_tokens;
		if (maxTokens) synced.maxTokens = maxTokens;

		if (m.reasoning || m.capabilities?.reasoning || m.capabilities?.thinking) synced.reasoning = true;

		const levelMap = buildThinkingLevelMap(normalizeEffortTiers(m.capabilities?.effort_tiers ?? m.effort_tiers));
		if (levelMap) synced.thinkingLevelMap = levelMap;

		upsertSyncedModel(results, synced);
	}

	return results
		.sort((a, b) => {
			const oa = a.owned_by || "zz";
			const ob = b.owned_by || "zz";
			if (oa !== ob) return oa.localeCompare(ob);
			return a.id.localeCompare(b.id);
		})
		.map(({ owned_by: _owned_by, ...rest }) => rest);
}

function buildProviderModelConfig(m: SyncedModel, override?: ModelOverride): ProviderModelConfig {
	const config: ProviderModelConfig = {
		id: m.id,
		name: m.name,
		api: PROVIDER_API,
		reasoning: m.reasoning ?? false,
		input: m.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow ?? 128_000,
		maxTokens: m.maxTokens ?? 16_384,
	};
	if (m.thinkingLevelMap) config.thinkingLevelMap = m.thinkingLevelMap;
	return override ? { ...config, ...override } : config;
}

function buildAutoModel(id: string): ProviderModelConfig {
	return {
		id,
		name: id,
		api: PROVIDER_API,
		reasoning: id === "auto/coding" || id === "auto/smart",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

async function discoverModels(config: OmniConfig): Promise<ProviderModelConfig[]> {
	const synced = await fetchSyncedModels(config);
	const allow = config.selectedModels ? new Set(config.selectedModels) : undefined;
	const picked = allow ? synced.filter((m) => allow.has(m.id)) : synced;
	const pickedIds = new Set(picked.map((m) => m.id));
	const autoModels = AUTO_MODELS.filter((id) => !pickedIds.has(id)).map(buildAutoModel);
	const overrides = config.modelOverrides ?? {};
	return [...autoModels, ...picked.map((m) => buildProviderModelConfig(m, overrides[m.id]))];
}

function buildProviderEntry(config: OmniConfig, models: ProviderModelConfig[]): any {
	return {
		baseUrl: `${config.serverUrl}/v1`,
		apiKey: config.apiKey || "omniroute-public",
		api: PROVIDER_API,
		authHeader: true,
		models,
	};
}

function persistModelsJson(agentHome: string, config: OmniConfig, models: ProviderModelConfig[]): void {
	const path = modelsJsonPath(agentHome);
	let file: any = {};
	try {
		file = JSON.parse(readFileSync(path, "utf8"));
	} catch {}
	if (!file.providers) file.providers = {};
	file.providers[config.providerName] = buildProviderEntry(config, models);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(file, null, 2));
}

async function registerOmniProvider(pi: OmniPI, agentHome: string, config: OmniConfig): Promise<ProviderModelConfig[]> {
	const models = await discoverModels(config);
	pi.registerProvider(config.providerName, buildProviderEntry(config, models));
	persistModelsJson(agentHome, config, models);
	return models;
}

function reloadProviderFromModelsJson(pi: OmniPI, agentHome: string, config: OmniConfig): void {
	try {
		const provider = readModelsJson(agentHome)?.providers?.[config.providerName];
		if (!provider) return;
		pi.registerProvider(config.providerName, provider);
	} catch {}
}

// ─── Display ──────────────────────────────────────────────────────────────────
function groupModels(models: ProviderModelConfig[]): Map<string, ProviderModelConfig[]> {
	const groups = new Map<string, ProviderModelConfig[]>();
	for (const m of models) {
		const group = AUTO_MODELS.includes(m.id) ? "auto" : m.id.includes("/") ? m.id.split("/")[0] : "direct";
		if (!groups.has(group)) groups.set(group, []);
		groups.get(group)!.push(m);
	}
	const entries = [...groups.entries()].sort(([a], [b]) => {
		if (a === "auto") return -1;
		if (b === "auto") return 1;
		return a.localeCompare(b);
	});
	return new Map(entries);
}

function modelLines(models: ProviderModelConfig[], query = "", limit = 80): string[] {
	const q = query.toLowerCase();
	const filtered = q ? models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)) : models;
	const sorted = [...filtered].sort((a, b) => sortKey(a.id).localeCompare(sortKey(b.id)) || a.id.localeCompare(b.id));
	const lines: string[] = [];
	for (const [group, gModels] of groupModels(sorted)) {
		lines.push(`-- ${group} (${gModels.length}) --`);
		for (const m of gModels) {
			const tags = [m.reasoning ? "reasoning" : "", m.input.includes("image") ? "vision" : ""].filter(Boolean).join(", ");
			lines.push(`  ${m.id} | ${m.contextWindow} ctx | ${m.maxTokens} out${tags ? ` | ${tags}` : ""}`);
			if (lines.length >= limit) break;
		}
		if (lines.length >= limit) break;
	}
	if (!filtered.length) lines.push("No models matched.");
	else if (filtered.length > limit) lines.push(`... ${filtered.length} total; refine with /omni models <search>`);
	return lines;
}

function routingSummary(config: OmniConfig): string {
	return [
		`mode=${config.routingMode}`,
		`budget=${config.budgetUsd === undefined ? "off" : `$${config.budgetUsd}`}`,
		`fallback=${config.budgetFallback}`,
		`compression=${config.compression}`,
	].join(", ");
}

function telemetryStatus(telemetry: RouteTelemetry, fallbackModel?: string): string {
	const route = [telemetry.provider, telemetry.model].filter(Boolean).join("/") || fallbackModel || "response";
	const extras = [
		telemetry.latencyMs ? `${telemetry.latencyMs}ms` : "",
		telemetry.costUsd ? `$${telemetry.costUsd}` : "",
		telemetry.cacheHit === "true" || telemetry.cacheHit === "HIT" ? "cache" : "",
	].filter(Boolean);
	return `↗ ${route}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
}

function telemetryLines(telemetry?: RouteTelemetry): string[] {
	if (!telemetry) return ["No OmniRoute response has been observed in this session."];
	return [
		`Status:      HTTP ${telemetry.status}`,
		`Route:       ${telemetry.provider ?? "?"}/${telemetry.model ?? "?"}`,
		`Decision:    ${telemetry.decision ?? "not reported"}`,
		`Latency:     ${telemetry.latencyMs ? `${telemetry.latencyMs} ms` : "not reported"}`,
		`Cost:        ${telemetry.costUsd ? `$${telemetry.costUsd}` : "not reported"}`,
		`Tokens:      ${telemetry.tokensIn ?? "?"} in / ${telemetry.tokensOut ?? "?"} out`,
		`Cache:       ${telemetry.cacheHit ?? "not reported"}`,
		`Fallbacks:   ${telemetry.fallbackAttempts ?? "0"}`,
		`Compression: ${telemetry.compression ?? "not reported"}`,
		`Request ID:  ${telemetry.requestId ?? "not reported"}`,
		`Version:     ${telemetry.version ?? "not reported"}`,
	];
}

async function showStatus(ctx: any, agentHome: string, config: OmniConfig): Promise<void> {
	const ok = await checkHealth(config);
	const configured = existsSync(configPath(agentHome));
	ctx.ui.notify(
		[
			"OmniRoute Status",
			"",
			`Server:     ${config.serverUrl}`,
			`Provider:   ${config.providerName}`,
			`Health:     ${ok ? "reachable" : "unreachable"}`,
			`Routing:    ${routingSummary(config)}`,
			`Configured: ${configured ? "yes" : "no — run /omni setup"}`,
		].join("\n"),
		ok ? "info" : "warning",
	);
}

function helpText(): string {
	return [
		"OmniRoute commands",
		"",
		"/omni                         Status",
		"/omni setup                   Configure server URL and API key",
		"/omni sync                    Pick models, then edit their metadata per tab",
		"/omni sync all                Register every endpoint model (clear allowlist)",
		"/omni models [search]         Browse models",
		"/omni test <model>            Smoke-test /v1/chat/completions",
		"/omni search <query>          Web search via /v1/search",
		"/omni route <mode|off>        Set per-request auto-routing mode",
		"/omni budget <usd|off> [strict|cheapest]",
		"/omni compression <mode>      Set mode, named combo, default, or off",
		"/omni last                    Show the latest routing telemetry",
		"/omni dashboard               Show OmniRoute dashboard URL",
		"/omni config                  Show paths and current settings",
		"/omni help                    Show this help",
	].join("\n");
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function runSetup(ctx: any, pi: OmniPI, agentHome: string): Promise<OmniConfig | undefined> {
	const current = loadConfig(agentHome);
	const serverUrl = await ctx.ui.input("OmniRoute server URL", current.serverUrl);
	if (serverUrl === undefined) return undefined;
	const apiKey = await ctx.ui.input(
		"OmniRoute API key",
		current.apiKey ? "(press enter to keep current)" : "(optional — press enter to skip)",
	);
	if (apiKey === undefined) return undefined;

	const next = sanitizeConfig({ ...current, serverUrl, apiKey: apiKey || current.apiKey });

	if (!(await checkHealth(next))) {
		ctx.ui.notify(`Cannot reach ${next.serverUrl}/v1/models.`, "error");
		return undefined;
	}

	saveConfig(agentHome, next);
	const models = await registerOmniProvider(pi, agentHome, next);
	;(ctx as any).modelRegistry?.refresh?.();
	ctx.ui.notify(`Saved. Synced ${models.length} model(s).`, "info");
	return next;
}

async function testChat(config: OmniConfig, model: string): Promise<string> {
	const data = await requestJson(
		config,
		"/v1/chat/completions",
		{
			method: "POST",
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: "Reply with exactly: ok" }],
				stream: false,
				max_tokens: 8,
			}),
		},
		20_000,
	);
	const content = data?.choices?.[0]?.message?.content;
	return typeof content === "string" ? content.trim() : JSON.stringify(data).slice(0, 200);
}

// ─── Interactive model selection + manual overrides ───────────────────────────
type ModelChoice = { id: string; name: string; contextWindow?: number; maxTokens?: number; input?: string[]; reasoning?: boolean };

/** Map a decoded CSI codepoint + modifier bitmask to a plain key string. */
function csiToKey(code: number, modifier: number): string | undefined {
	const ctrl = (modifier & 4) !== 0;
	if (code === 13) return "\r";
	if (code === 9) return (modifier & 1) !== 0 ? "\x1b[Z" : "\t";
	if (code === 27) return "\x1b";
	if (code === 32) return ctrl ? "\x00" : " ";
	if (code === 127 || code === 8) return "\x7f";
	// Kitty functional arrows (positive codepoints) and parseKittySequence's
	// negative internal codepoints.
	const funcArrow = FUNC_ARROWS.get(code);
	if (funcArrow) return funcArrow;
	if (code === -1) return "\x1b[A";
	if (code === -2) return "\x1b[B";
	if (code === -3) return "\x1b[C";
	if (code === -4) return "\x1b[D";
	if (code === -12) return "\x1b[5~";
	if (code === -13) return "\x1b[6~";
	if (ctrl && code >= 97 && code <= 122) return String.fromCharCode(code - 96);
	if (ctrl && code >= 65 && code <= 90) return String.fromCharCode(code - 64);
	if (code >= 32 && code < 127) return String.fromCharCode(code);
	return undefined;
}

/** Kitty CSI-u functional codepoints for arrows and page keys. */
const FUNC_ARROWS = new Map<number, string>([
	[57350, "\x1b[D"],
	[57351, "\x1b[C"],
	[57352, "\x1b[A"],
	[57353, "\x1b[B"],
	[57354, "\x1b[5~"],
	[57355, "\x1b[6~"],
	[57417, "\x1b[D"],
	[57418, "\x1b[C"],
	[57419, "\x1b[A"],
	[57420, "\x1b[B"],
	[57421, "\x1b[5~"],
	[57422, "\x1b[6~"],
]);

/**
 * Normalize every key encoding we may receive into a canonical legacy sequence:
 * plain ASCII, legacy CSI (\x1b[A), kitty CSI-u (\x1b[97;5:1u), and xterm
 * modifyOtherKeys (\x1b[27;5;97~). Also strips key-release events.
 */
function normalizeKey(data: string): string {
	if (!data.startsWith("\x1b")) return data;

	// Kitty CSI-u: CSI key[:alts] ; mods[:event] ; text u
	if (data.endsWith("u")) {
		const parts = data.slice(2, -1).split(";");
		const codePart = (parts[0] ?? "").split(":");
		const code = Number(codePart[0]);
		if (Number.isFinite(code)) {
			const modPart = (parts[1] ?? "").split(":");
			const modifier = modPart[0] ? Number(modPart[0]) - 1 : 0;
			if (modPart[1] === "3") return ""; // key release
			return csiToKey(code, modifier) ?? data;
		}
	}

	// Arrow/page with modifier: \x1b[1;<mod>[:<event>]A|B|C|D or \x1b[1;<mod>~ variants
	const arrow = /^\x1b\[1;(\d+)(?::(\d+))?([ABCD])$/.exec(data);
	if (arrow) {
		if (arrow[2] === "3") return "";
		const base: Record<string, string> = { A: "\x1b[A", B: "\x1b[B", C: "\x1b[C", D: "\x1b[D" };
		return base[arrow[3]] ?? data;
	}

	// Page up/down with modifier: \x1b[5;<mod>~ or \x1b[6;<mod>~
	const page = /^\x1b\[([56]);(\d+)(?::(\d+))?~$/.exec(data);
	if (page) {
		if (page[3] === "3") return "";
		return Number(page[1]) === 5 ? "\x1b[5~" : "\x1b[6~";
	}

	// xterm modifyOtherKeys: \x1b[27;<mod>;<code>~
	const mok = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);
	if (mok) return csiToKey(Number(mok[2]), Number(mok[1]) - 1) ?? data;

	return data;
}

/** Self-contained multi-select with incremental filter; no host/pi-tui imports. */
async function pickModels(ctx: any, choices: ModelChoice[], preselected?: string[]): Promise<string[] | undefined> {
	if (ctx.mode !== "tui" || typeof ctx.ui?.custom !== "function" || choices.length === 0) return undefined;
	return ctx.ui.custom((tui: any, theme: any, _kb: any, done: (v: string[] | undefined) => void) => {
		const checked = new Set(preselected ?? choices.map((c) => c.id));
		let filter = "";
		let cursor = 0;
		let cached: string[] | undefined;
		const PAGE = 14;
		const fg = (color: string, text: string): string => (theme?.fg ? theme.fg(color, text) : text);
		const truncate = (text: string, width: number): string =>
			text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
		const view = (): ModelChoice[] => {
			const q = filter.toLowerCase();
			return q ? choices.filter((c) => `${c.id} ${c.name}`.toLowerCase().includes(q)) : choices;
		};

		const render = (width: number): string[] => {
			if (cached) return cached;
			const items = view();
			if (cursor >= items.length) cursor = Math.max(0, items.length - 1);
			let start = Math.max(0, Math.min(cursor - Math.floor(PAGE / 2), items.length - PAGE));
			if (start < 0) start = 0;
			const window = items.slice(start, start + PAGE);
			const lines: string[] = [];
			lines.push(truncate(`Select models to register (${checked.size}/${choices.length} checked)`, width));
			lines.push(fg("muted", truncate(`filter: ${filter}${filter ? "" : " (type to search)"}`, width)));
			for (let i = 0; i < window.length; i++) {
				const item = window[i];
				const active = start + i === cursor;
				const mark = checked.has(item.id) ? "x" : " ";
				const prefix = active ? "> " : "  ";
				const line = `${prefix}[${mark}] ${item.id}`;
				lines.push(fg(active ? "accent" : checked.has(item.id) ? "text" : "muted", truncate(line, width)));
			}
			if (items.length === 0) lines.push(fg("warning", "no models match"));
			lines.push(
				fg(
					"dim",
					truncate(`↑↓ move • space toggle • ctrl+a all ctrl+n none • enter confirm • esc cancel • ${items.length} shown`, width),
				),
			);
			cached = lines;
			return lines;
		};

		const refresh = (): void => {
			cached = undefined;
			tui.requestRender?.();
		};

		const handleInput = (raw: string): void => {
			const data = normalizeKey(raw);
			if (data === "") return; // key release
			if (data === "\x1b" || data === "\x03") return done(undefined);
			if (data === "\r" || data === "\n") return done([...checked]);
			const items = view();
			if (data === "\x1b[A") cursor = Math.max(0, cursor - 1);
			else if (data === "\x1b[B") cursor = Math.min(items.length - 1, cursor + 1);
			else if (data === "\x1b[5~") cursor = Math.max(0, cursor - PAGE);
			else if (data === "\x1b[6~") cursor = Math.min(items.length - 1, cursor + PAGE);
			else if (data === " ") {
				const item = items[cursor];
				if (item) (checked.has(item.id) ? checked.delete(item.id) : checked.add(item.id));
			}
			// Ctrl combos so printable letters always go to the filter. Cover legacy
			// control bytes and the kitty space encoding (ctrl+space = NUL).
			else if (data === "\x01") for (const item of items) checked.add(item.id);
			else if (data === "\x0e" || data === "\x00") for (const item of items) checked.delete(item.id);
			else if (data === "\x7f" || data === "\b") {
				filter = filter.slice(0, -1);
				cursor = 0;
			}
			else if (data === "\x15") {
				filter = "";
				cursor = 0;
			}
			else if (data >= " " && !data.startsWith("\x1b")) {
				filter += data;
				cursor = 0;
			}
			refresh();
		};

		return { render, invalidate: () => (cached = undefined), handleInput };
	});
}

/** Editable metadata row shown in the per-model override editor. */
type OverrideField = {
	key: "contextWindow" | "maxTokens" | "reasoning" | "input";
	label: string;
	format(model: ModelChoice, value: ModelOverride): string;
	/** Parse typed text into a patch value; undefined = leave unchanged. */
	parse(text: string): unknown;
};

const OVERRIDE_FIELDS: OverrideField[] = [
	{
		key: "contextWindow",
		label: "context size",
		format: (m, v) => String(v.contextWindow ?? m.contextWindow ?? "unknown"),
		parse: (t) => {
			const n = Number(t.replace(/[^0-9]/g, ""));
			return Number.isFinite(n) && n > 0 ? n : undefined;
		},
	},
	{
		key: "maxTokens",
		label: "max output tokens",
		format: (m, v) => String(v.maxTokens ?? m.maxTokens ?? "unknown"),
		parse: (t) => {
			const n = Number(t.replace(/[^0-9]/g, ""));
			return Number.isFinite(n) && n > 0 ? n : undefined;
		},
	},
	{
		key: "reasoning",
		label: "thinking capability",
		format: (m, v) => ((v.reasoning ?? m.reasoning) ? "yes" : "no"),
		parse: (t) => (/^(y|yes|true|on|1)$/i.test(t) ? true : /^(n|no|false|off|0)$/i.test(t) ? false : undefined),
	},
	{
		key: "input",
		label: "image support",
		format: (m, v) => ((v.input ?? m.input ?? ["text"]).includes("image") ? "yes" : "no"),
		// yes/no toggles image; anything else is treated as an explicit modality list.
		parse: (t) => {
			if (/^(y|yes|true|on|1)$/i.test(t)) return ["text", "image"];
			if (/^(n|no|false|off|0)$/i.test(t)) return ["text"];
			const mods = normalizeModalities(t);
			return mods.length > 0 ? mods : undefined;
		},
	},
];

/**
 * Tabbed per-model override editor. One tab per selected model shows the endpoint
 * metadata as inline defaults; typing edits the focused field. Used only in TUI mode.
 */
async function editModelOverrides(
	ctx: any,
	models: ModelChoice[],
	existing: Record<string, ModelOverride>,
): Promise<Record<string, ModelOverride> | undefined> {
	if (typeof ctx.ui?.custom !== "function" || models.length === 0) return undefined;
	return ctx.ui.custom((tui: any, theme: any, _kb: any, done: (v: Record<string, ModelOverride> | undefined) => void) => {
		const drafts: Record<string, ModelOverride> = {};
		for (const model of models) drafts[model.id] = { ...(existing[model.id] ?? {}) };
		let tab = 0;
		let field = 0;
		// null = browsing rows; string = editing the focused row's text
		let draft: string | null = null;
		let cached: string[] | undefined;
		const fg = (color: string, text: string): string => (theme?.fg ? theme.fg(color, text) : text);
		const truncate = (text: string, width: number): string =>
			text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
		const model = (): ModelChoice => models[tab];
		const current = (): ModelOverride => drafts[model().id] ?? (drafts[model().id] = {});

		const tabLine = (width: number): string => {
			const names = models.map((m, i) => (i === tab ? fg("accent", `[${m.name}]`) : fg("muted", ` ${m.name} `)));
			return truncate(names.join(" "), width);
		};

		const render = (width: number): string[] => {
			if (cached) return cached;
			const lines: string[] = [];
			lines.push(fg("dim", "Manual metadata overrides — blank or unchanged keeps endpoint values"));
			lines.push(tabLine(width));
			lines.push(fg("border", "─".repeat(Math.max(0, Math.min(width, 60)))));
			for (let i = 0; i < OVERRIDE_FIELDS.length; i++) {
				const f = OVERRIDE_FIELDS[i];
				const active = i === field;
				const shown = active && draft !== null ? (draft === "" ? fg("dim", f.format(model(), current())) : draft) : f.format(model(), current());
				const marker = active ? "❯" : " ";
				const label = `${marker} ${f.label}:`;
				const line = `${label.padEnd(24)} ${shown}${active && draft !== null ? "▎" : ""}`;
				lines.push(fg(active ? "accent" : "text", truncate(line, width)));
			}
			lines.push("");
			lines.push(
				fg(
					"dim",
					truncate(
						draft !== null
							? "type value • enter apply • esc cancel field"
							: `↑↓ field • ←→ or tab model (${tab + 1}/${models.length}) • enter edit • ctrl+s save • esc discard`,
						width,
					),
				),
			);
			cached = lines;
			return lines;
		};

		const refresh = (): void => {
			cached = undefined;
			tui.requestRender?.();
		};

		// Drop empty patches and values that merely restate endpoint metadata.
		const pruneDrafts = (): Record<string, ModelOverride> => {
			const out: Record<string, ModelOverride> = {};
			for (const model of models) {
				const patch = { ...(drafts[model.id] ?? {}) };
				if (patch.contextWindow !== undefined && patch.contextWindow === model.contextWindow) delete patch.contextWindow;
				if (patch.maxTokens !== undefined && patch.maxTokens === model.maxTokens) delete patch.maxTokens;
				if (patch.reasoning !== undefined && patch.reasoning === (model.reasoning ?? false)) delete patch.reasoning;
				const base = (model.input ?? ["text"]).join(",");
				if (patch.input && patch.input.join(",") === base) delete patch.input;
				if (Object.keys(patch).length > 0) out[model.id] = patch;
			}
			return out;
		};

		const commitField = (): void => {
			if (draft === null) return;
			const f = OVERRIDE_FIELDS[field];
			const parsed = f.parse(draft);
			if (parsed !== undefined) (current() as Record<string, unknown>)[f.key] = parsed;
			else if (draft.trim() === "") delete (current() as Record<string, unknown>)[f.key];
			draft = null;
		};

		const handleInput = (raw: string): void => {
			const data = normalizeKey(raw);
			if (data === "") return; // key release

			if (draft !== null) {
				if (data === "\x1b" || data === "\x03") {
					draft = null;
					refresh();
					return;
				}
				if (data === "\r" || data === "\n") {
					commitField();
					refresh();
					return;
				}
				if (data === "\x7f" || data === "\b") draft = draft.slice(0, -1);
				else if (data === "\x15") draft = "";
				else if (data >= " " && !data.startsWith("\x1b")) draft += data;
				refresh();
				return;
			}

			if (data === "\x1b" || data === "\x03") return done(undefined);
			if (data === "\x13") return done(pruneDrafts()); // ctrl+s
			if (data === "\r" || data === "\n") {
				// Start with an empty buffer: type to replace, blank keeps the default.
				draft = "";
				refresh();
				return;
			}
			if (data === "\x1b[A") field = (field - 1 + OVERRIDE_FIELDS.length) % OVERRIDE_FIELDS.length;
			else if (data === "\x1b[B") field = (field + 1) % OVERRIDE_FIELDS.length;
			else if (data === "\x1b[C" || data === "\t") tab = (tab + 1) % models.length;
			else if (data === "\x1b[D" || data === "\x1b[Z") tab = (tab - 1 + models.length) % models.length;
			refresh();
		};

		return { render, invalidate: () => (cached = undefined), handleInput };
	});
}

// ─── Factory ──────────────────────────────────────────────────────────────────
export async function createOmniExtension(pi: OmniPI, opts: AgentHomeOptions): Promise<void> {
	const agentHome = resolveAgentHome(opts);
	let config = loadConfig(agentHome);
	let healthTimer: ReturnType<typeof setInterval> | undefined;
	let lastTelemetry: RouteTelemetry | undefined;

	async function sync(ctx?: any, options: { all?: boolean } = {}): Promise<number> {
		config = loadConfig(agentHome);
		let changed = Boolean(options.all);

		if (options.all) {
			config = sanitizeConfig({ ...config, selectedModels: undefined });
		} else if (ctx?.mode === "tui") {
			const synced = await fetchSyncedModels(config);
			const choices: ModelChoice[] = [
				...AUTO_MODELS.map((id) => ({ id, name: id })),
				...synced.map((m) => ({
					id: m.id,
					name: m.name,
					contextWindow: m.contextWindow,
					maxTokens: m.maxTokens,
					input: m.input,
					reasoning: m.reasoning,
				})),
			];
			const picked = await pickModels(ctx, choices, config.selectedModels);
			if (picked === undefined) {
				ctx.ui.notify("Sync cancelled.", "info");
				return 0;
			}
			config = sanitizeConfig({ ...config, selectedModels: picked });
			changed = true;

			// Next step: tabbed editor over the picked models (auto/* virtual models carry
			// no endpoint metadata, so only real picks are editable).
			const byId = new Map(choices.map((c) => [c.id, c]));
			const editable = picked.map((id) => byId.get(id)).filter((c): c is ModelChoice => Boolean(c) && !AUTO_MODELS.includes(c!.id));
			if (editable.length > 0) {
				const edited = await editModelOverrides(ctx, editable, config.modelOverrides ?? {});
				if (edited === undefined) ctx.ui.notify("Kept existing overrides.", "info");
				else config = sanitizeConfig({ ...config, modelOverrides: edited });
			}
		}

		if (changed) saveConfig(agentHome, config);
		const models = await registerOmniProvider(pi, agentHome, config);
		;(ctx as any)?.modelRegistry?.refresh?.();
		ctx?.ui.notify(`OmniRoute synced ${models.length} model(s).`, "info");
		return models.length;
	}

	// On load: re-register from existing models.json (no network call)
	reloadProviderFromModelsJson(pi, agentHome, config);

	// Tie Pi's conversation to OmniRoute affinity/cost logs and apply persistent
	// request-scoped routing controls without changing the selected model.
	pi.on("before_provider_headers", (event: any, ctx: any) => {
		config = loadConfig(agentHome);
		if (ctx.model?.provider !== config.providerName) return;
		const sessionId = ctx.sessionManager?.getSessionId?.();
		if (sessionId) event.headers["X-OmniRoute-Session-Id"] = sessionId;
		if (config.routingMode !== "default") event.headers["X-OmniRoute-Mode"] = config.routingMode;
		if (config.budgetUsd !== undefined) {
			event.headers["X-OmniRoute-Budget"] = String(config.budgetUsd);
			event.headers["X-OmniRoute-Budget-Fallback"] = config.budgetFallback;
		}
		if (config.compression !== "default") event.headers["X-OmniRoute-Compression"] = config.compression;
	});

	pi.on("after_provider_response", (event: any, ctx: any) => {
		config = loadConfig(agentHome);
		if (ctx.model?.provider !== config.providerName) return;
		const headers = event.headers ?? {};
		const header = (name: string): string | undefined => {
			const value = headers[name.toLowerCase()] ?? headers[name] ?? headers[Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase()) ?? ""];
			return value === undefined || value === null ? undefined : String(value);
		};
		lastTelemetry = {
			status: Number(event.status) || 0,
			requestId: header("x-omniroute-request-id"),
			model: header("x-omniroute-model") ?? ctx.model?.id,
			provider: header("x-omniroute-provider"),
			decision: header("x-omniroute-decision"),
			latencyMs: header("x-omniroute-latency-ms"),
			costUsd: header("x-omniroute-response-cost"),
			tokensIn: header("x-omniroute-tokens-in"),
			tokensOut: header("x-omniroute-tokens-out"),
			cacheHit: header("x-omniroute-cache-hit") ?? header("x-omniroute-cache"),
			fallbackAttempts: header("x-omniroute-fallback-attempts"),
			compression: header("x-omniroute-compression"),
			version: header("x-omniroute-version"),
			receivedAt: Date.now(),
		};
		ctx.ui.setStatus("omni", telemetryStatus(lastTelemetry, ctx.model?.id));
	});

	pi.on("session_start", async (_event: any, ctx: any) => {
		config = loadConfig(agentHome);
		if (!existsSync(configPath(agentHome)) && !process.env.OMNIROUTE_URL) {
			ctx.ui.setStatus("omni", "OmniRoute unconfigured");
			ctx.ui.notify("OmniRoute loaded. Run /omni setup to connect.", "warning");
			return;
		}
		const ok = await checkHealth(config);
		ctx.ui.setStatus("omni", ok ? undefined : "OmniRoute unreachable");
		if (!ok) ctx.ui.notify(`OmniRoute unreachable at ${config.serverUrl}. Run /omni sync after reconnecting.`, "warning");
		if (healthTimer) clearInterval(healthTimer);
		healthTimer = setInterval(async () => {
			const healthy = await checkHealth(loadConfig(agentHome));
			if (!healthy) {
				ctx.ui.setStatus("omni", "OmniRoute unreachable");
			} else if (ctx.model?.provider !== config.providerName) {
				ctx.ui.setStatus("omni", undefined);
			} else if (lastTelemetry) {
				ctx.ui.setStatus("omni", telemetryStatus(lastTelemetry, ctx.model.id));
			} else {
				ctx.ui.setStatus("omni", `→ ${ctx.model.id}`);
			}
		}, 60_000);
	});

	pi.on("session_shutdown", () => {
		if (healthTimer) clearInterval(healthTimer);
		healthTimer = undefined;
		lastTelemetry = undefined;
	});

	pi.on("model_select", async (event: any, ctx: any) => {
		config = loadConfig(agentHome);
		const id = event.model?.id;
		ctx.ui.setStatus("omni", event.model?.provider === config.providerName && id ? `→ ${id}` : undefined);
	});

	pi.registerTool({
		name: "omniroute_status",
		label: "OmniRoute Status",
		description: "Return OmniRoute health and provider registration status.",
		parameters: { type: "object", properties: {} },
		async execute(_id: string, _params: any) {
			const cfg = loadConfig(agentHome);
			const ok = await checkHealth(cfg);
			const configured = existsSync(configPath(agentHome));
			return {
				content: [
					{
						type: "text" as const,
						text: `OmniRoute ${ok ? "reachable" : "unreachable"}; configured: ${configured}; provider: ${cfg.providerName}; ${routingSummary(cfg)}.`,
					},
				],
				details: {
					ok,
					configured,
					serverUrl: cfg.serverUrl,
					providerName: cfg.providerName,
					routing: {
						mode: cfg.routingMode,
						budgetUsd: cfg.budgetUsd,
						budgetFallback: cfg.budgetFallback,
						compression: cfg.compression,
					},
					lastTelemetry,
				},
			};
		},
	});

	pi.registerTool({
		name: "omniroute_search",
		label: "OmniRoute Web Search",
		description: "Search the web via OmniRoute /v1/search (Serper, Brave, Exa, etc.).",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				max_results: { type: "number", description: "1-100, default 5" },
				provider: { type: "string", description: "Search provider id, e.g. serper-search, brave-search, exa-search, duckduckgo-free (omit for auto)" },
				search_type: { type: "string", enum: ["web", "news"], description: "Default web" },
			},
			required: ["query"],
		},
		async execute(_id: string, params: any) {
			const cfg = loadConfig(agentHome);
			const query = String(params?.query ?? "").trim();
			if (!query) return { content: [{ type: "text" as const, text: "query is required." }] };
			const data = await webSearch(cfg, {
				query,
				max_results: params?.max_results,
				provider: params?.provider,
				search_type: params?.search_type,
			});
			return { content: [{ type: "text" as const, text: formatSearchResults(data) }], details: { provider: data.provider, query: data.query, count: data.results?.length ?? 0 } };
		},
	});

	pi.registerTool({
		name: "omniroute_sync",
		label: "OmniRoute Sync",
		description: "Fetch /v1/models from OmniRoute and register them as a provider.",
		parameters: { type: "object", properties: {} },
		async execute(_id: string, _params: any) {
			const cfg = loadConfig(agentHome);
			const models = await registerOmniProvider(pi, agentHome, cfg);
			return {
				content: [{ type: "text" as const, text: `OmniRoute synced ${models.length} model(s).` }],
				details: { count: models.length, provider: cfg.providerName },
			};
		},
	});

	pi.registerCommand("omni", {
		description: "OmniRoute: setup, sync, routing controls, and live telemetry",
		getArgumentCompletions(prefix: string) {
			return ["setup", "sync", "models", "test", "search", "route", "budget", "compression", "last", "dashboard", "config", "help"]
				.filter((v) => v.startsWith(prefix))
				.map((v) => ({ value: v, label: v }));
		},
		async handler(args: string, ctx: any) {
			const [subRaw, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const sub = subRaw?.toLowerCase() ?? "";
			config = loadConfig(agentHome);

			try {
				if (!sub) return showStatus(ctx, agentHome, config);
				if (sub === "help") return ctx.ui.notify(helpText(), "info");

				if (sub === "setup") {
					const next = await runSetup(ctx, pi, agentHome);
					if (next) config = next;
					return;
				}

				if (sub === "sync") {
					await sync(ctx, { all: rest[0] === "all" });
					return;
				}

				if (sub === "models") {
					const models = await discoverModels(config).catch(() => []);
					return ctx.ui.notify(
						[`OmniRoute models (${models.length})`, "", ...modelLines(models, rest.join(" "))].join("\n"),
						"info",
					);
				}

				if (sub === "test") {
					const model = rest.join(" ");
					if (!model) return ctx.ui.notify("Usage: /omni test <model>", "warning");
					const result = await testChat(config, model);
					return ctx.ui.notify(`Test ${model}: ${result}`, "info");
				}

				if (sub === "search") {
					const query = rest.join(" ").trim();
					if (!query) return ctx.ui.notify("Usage: /omni search <query>", "warning");
					const data = await webSearch(config, { query }).catch((error) => {
						ctx.ui.notify(`Search failed: ${(error as Error).message}`, "error");
						return undefined;
					});
					if (data) return ctx.ui.notify(formatSearchResults(data), "info");
					return;
				}

				if (sub === "route") {
					const requested = String(rest[0] ?? "").toLowerCase();
					const mode = (requested === "off" ? "default" : requested) as RoutingMode;
					if (!ROUTING_MODES.includes(mode)) {
						return ctx.ui.notify(`Usage: /omni route <${ROUTING_MODES.join("|")}|off>`, "warning");
					}
					config = sanitizeConfig({ ...config, routingMode: mode });
					saveConfig(agentHome, config);
					return ctx.ui.notify(`OmniRoute routing mode: ${mode}`, "info");
				}

				if (sub === "budget") {
					const value = String(rest[0] ?? "").toLowerCase();
					const fallback = String(rest[1] ?? config.budgetFallback).toLowerCase();
					if (value !== "off" && (!Number.isFinite(Number(value)) || Number(value) <= 0)) {
						return ctx.ui.notify("Usage: /omni budget <positive-usd|off> [strict|cheapest]", "warning");
					}
					if (fallback !== "strict" && fallback !== "cheapest") {
						return ctx.ui.notify("Budget fallback must be strict or cheapest.", "warning");
					}
					config = sanitizeConfig({ ...config, budgetUsd: value === "off" ? undefined : Number(value), budgetFallback: fallback as BudgetFallback });
					saveConfig(agentHome, config);
					return ctx.ui.notify(`OmniRoute budget: ${config.budgetUsd === undefined ? "off" : `$${config.budgetUsd} (${config.budgetFallback})`}`, "info");
				}

				if (sub === "compression") {
					const mode = rest.join(" ").trim();
					if (!mode) return ctx.ui.notify("Usage: /omni compression <mode|named-combo|default|off>", "warning");
					config = sanitizeConfig({ ...config, compression: mode });
					saveConfig(agentHome, config);
					return ctx.ui.notify(`OmniRoute compression: ${config.compression}`, "info");
				}

				if (sub === "last") {
					return ctx.ui.notify(["Latest OmniRoute route", "", ...telemetryLines(lastTelemetry)].join("\n"), lastTelemetry?.status && lastTelemetry.status >= 400 ? "warning" : "info");
				}

				if (sub === "dashboard" || sub === "dash") {
					return ctx.ui.notify(`OmniRoute dashboard: ${config.serverUrl}`, "info");
				}

				if (sub === "config") {
					return ctx.ui.notify(
						[
							`Config:   ${configPath(agentHome)}`,
							`Models:   ${modelsJsonPath(agentHome)}`,
							`Configured: ${existsSync(configPath(agentHome)) ? "yes" : "no"}`,
							`Server:   ${config.serverUrl}`,
							`Provider: ${config.providerName}`,
							`Routing:  ${routingSummary(config)}`,
						].join("\n"),
						"info",
					);
				}

				ctx.ui.notify(`Unknown /omni command '${sub}'.\n\n${helpText()}`, "warning");
			} catch (error) {
				ctx.ui.notify(`OmniRoute error: ${(error as Error).message}`, "error");
			}
		},
	});
}
