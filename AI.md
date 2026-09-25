# AI Handoff Guide

## Repository Purpose

Dual-host extension integrating OmniRoute with Pi Coding Agent and Oh My Pi. It provides model discovery/registration, setup commands, health checks, request-scoped routing controls, Pi-session affinity, and live response telemetry.

## Read Order

1. `AGENTS.md`
2. `ARCHITECTURE.md`
3. `README.md`
4. `CONTRIBUTING.md`
5. `shared.ts`

## File Map

| Path | Purpose |
|---|---|
| `shared.ts` | All host-neutral implementation and local compatibility interfaces. |
| `pi.ts` | Pi adapter; selects `PI_HOME` / `~/.pi/agent`. |
| `omp.ts` | Oh My Pi adapter; selects `OMP_HOME` / `~/.omp/agent`. |
| `README.md` | User-facing install, commands, and environment variables. |
| `ARCHITECTURE.md` | Current model/provider/header/telemetry flow. |
| `package.json` | Both extension manifests and validation scripts. |

## Key Functions in `shared.ts`

- `loadConfig()` / `sanitizeConfig()` — backward-compatible file + environment resolution (includes `modelOverrides`).
- `discoverModels()` — calls `/v1/models`, normalizes metadata (context, output, reasoning, effort tiers, vision), applies `modelOverrides`, and adds missing auto models.
- `registerOmniProvider()` — live registration plus `models.json` persistence.
- `reloadProviderFromModelsJson()` — offline startup registration.
- `buildProviderEntry()` — native `openai-completions` provider configuration.
- `buildThinkingLevelMap()` / `sanitizeModelOverrides()` — map `effort_tiers` to Pi thinking levels and validate per-model metadata patches.
- `routingSummary()` / `telemetryLines()` — safe user-visible formatting.
- `webSearch()` / `formatSearchResults()` — `POST /v1/search` plus result formatting for the search tool and `/omni search`.
- `createOmniExtension()` — lifecycle hooks, tools, and `/omni` dispatch.

## Invariants

- Keep normal `/model` selection; do not create duplicate model providers.
- Keep all business logic in `shared.ts` unless both host adapters are updated intentionally.
- Preserve unrelated entries in `models.json`.
- Apply provider hooks only when `ctx.model.provider === config.providerName`.
- Never display or return the OmniRoute API key in notifications, telemetry, or tool details.
- Start intervals only in `session_start`; clear them in `session_shutdown`.
- Update README and architecture docs with behavior changes.

## OmniRoute Integration Surface

- `GET /v1/models` for health/discovery.
- `POST /v1/chat/completions` through the host's native OpenAI-compatible provider.
- `POST /v1/search` for the web search tool and `/omni search`.
- Request headers: session ID, mode, budget/fallback, compression.
- Response headers: route, cost, token, cache, fallback, compression, request, and version telemetry.

Do not use management `/api/*` routes without designing separate management authentication and permission handling.

## Validation

```bash
npm install
npm run typecheck
npm run smoke
```

Expected smoke output:

```text
omp ok
pi ok
```
