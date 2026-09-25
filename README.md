# omniroute-agent-extension

[![npm version](https://img.shields.io/npm/v/omniroute-agent-extension.svg?style=flat-square)](https://www.npmjs.com/package/omniroute-agent-extension)
[![npm downloads](https://img.shields.io/npm/dm/omniroute-agent-extension.svg?style=flat-square)](https://www.npmjs.com/package/omniroute-agent-extension)

OmniRoute extension for [Pi Coding Agent](https://pi.dev) (`pi`) and [Oh My Pi](https://omp.sh) (`omp`).

Connect to your local or remote OmniRoute server and route queries across 44+ LLM providers directly from your agent CLI.

## Features

- **Wizard-based setup** — `/omni setup` inside `pi` or `omp`. No manual JSON editing.
- **Dual CLI support** — one package, identical feature set for both `pi` and `omp`.
- **Model sync** — push all OmniRoute models into the `Ctrl+P` / `/model` picker with full metadata: context windows, max tokens, reasoning, effort tiers, and vision capabilities.
- **Native tool calls** — the host's built-in `openai-completions` handler runs every request, so you get real SSE streaming and native `tool_calls` for all models.
- **Smart sorting** — models grouped by provider prefix, auto-routing models (`auto`, `auto/coding`, etc.) always first.
- **Health monitoring** — periodic reachability checks with status bar indicators.
- **Per-request routing controls** — choose OmniRoute mode packs, enforce a USD budget, and select compression without changing models.
- **Session affinity** — Pi's session ID is forwarded as `X-OmniRoute-Session-Id` for sticky routing, cache affinity, and per-session cost attribution.
- **Live route telemetry** — the status bar and `/omni last` show the actual provider/model, routing decision, latency, cost, tokens, cache hit, fallbacks, compression, and request ID reported by OmniRoute.
- **Web search tool** — `omniroute_search` tool and `/omni search` run web/news search through OmniRoute's `/v1/search` (Serper, Brave, Exa, DuckDuckGo, and more).
- **Env overrides** — configure connection and routing behavior entirely through environment variables.

## Installation

Install from git (recommended — this fork):

**Pi Coding Agent:**

```bash
pi install git:github.com/evanhfw/pi-omniroute
```

**Oh My Pi:**

```bash
omp install git:github.com/evanhfw/pi-omniroute
```

Pin a branch, tag, or commit for reproducible installs:

```bash
pi install git:github.com/evanhfw/pi-omniroute@<tag-or-sha>
```

Or install from npm:

```bash
pi install npm:omniroute-agent-extension
omp install npm:omniroute-agent-extension
```

The install adds a `packages` entry to settings (`~/.pi/agent/settings.json` or `~/.omp/agent/settings.json`) and clones the source into the agent `git/` directory. Restart the CLI after installing or updating. `pi update --extensions` reconciles installed packages, and `pi -e git:github.com/evanhfw/pi-omniroute` runs the package for one session without saving it.

Local development (run straight from a checkout):

```bash
pi install ./pi-omniroute
```

Extensions load at startup, so restart the CLI after editing extension source.

## Getting Started

1. Start your CLI (`pi` or `omp`)
2. Run `/omni setup` — enter your OmniRoute server URL and API key
3. Run `/omni sync` — populates the `Ctrl+P` / `/model` picker
4. Select any model with `/model` and start chatting

Config is saved to:

| CLI | Config path |
|---|---|
| `omp` | `~/.omp/agent/omniroute-agent-extension/config.json` |
| `pi` | `~/.pi/agent/omniroute-agent-extension/config.json` |

Synced models are written to `~/.omp/agent/models.json` (or `~/.pi/agent/models.json`) and reloaded on startup without a network call.

Some models omit metadata on `/v1/models` (e.g. output limit or vision support). Patch individual models with `modelOverrides` in `config.json`, keyed by exact model id:

```json
{
  "modelOverrides": {
    "cmd/deepseek/deepseek-v4.1-flash": { "maxTokens": 384000, "input": ["text", "image"] }
  }
}
```

Allowed override fields: `name`, `reasoning`, `thinkingLevelMap`, `input`, `contextWindow`, `maxTokens`.

## Commands

| Command | Description |
|---|---|
| `/omni` | Server health and provider status |
| `/omni setup` | Configure server URL and API key interactively |
| `/omni sync` | Fetch `/v1/models` and register models in the picker |
| `/omni models [search]` | Browse synced models with optional keyword filter |
| `/omni test <model>` | Smoke-test `/v1/chat/completions` with a specific model |
| `/omni search <query>` | Web search through OmniRoute `/v1/search` |
| `/omni route <mode\|off>` | Set the per-request auto-routing mode: `fast`, `balanced`, `quality`, `cheap`, `reliable`, or `offline` |
| `/omni budget <usd\|off> [strict\|cheapest]` | Apply a per-request cost ceiling and choose hard-fail or cheapest fallback behavior |
| `/omni compression <mode>` | Set an OmniRoute compression mode, named compression combo, `default`, or `off` |
| `/omni last` | Inspect telemetry from the latest OmniRoute provider response |
| `/omni dashboard` | Show the OmniRoute dashboard URL |
| `/omni config` | Show config/model paths and current routing controls |
| `/omni help` | Show command list |

## Agent Tools

Three tools the LLM can call directly:

- **`omniroute_status`** — returns server reachability, config path, and provider name
- **`omniroute_sync`** — fetches `/v1/models` and re-registers the provider (same as `/omni sync`)
- **`omniroute_search`** — searches the web or news via OmniRoute `/v1/search`; optional `max_results` (1–100, default 5), `provider` (e.g. `serper-search`, `brave-search`, `exa-search`, `duckduckgo-free`), and `search_type` (`web`/`news`)

Tool calls go through the same OmniRoute server as chat requests, so search provider credentials and quota live server-side; no API key is exposed in the tool.

## How It Works

The extension registers OmniRoute as an `openai-completions` provider. After `/omni sync`, all models appear in the picker. Every request is handled natively by the host's built-in `openai-completions` handler — real SSE streaming and native `tool_calls`.

Before an OmniRoute request, the extension adds the Pi session ID plus any configured routing, budget, and compression headers. When OmniRoute responds, it reads the `X-OmniRoute-*` telemetry headers and updates the Pi status bar.

```text
agent
  -> /model auto/coding
  -> X-OmniRoute-Session-Id + routing controls
  -> OmniRoute /v1/chat/completions (SSE stream)
  -> token-by-token output, native tool_calls
  -> X-OmniRoute-* route/cost/cache telemetry
  -> agent executes tools
```

## Auto Models

These virtual model IDs are always prepended to the synced list. OmniRoute resolves them server-side to the best available model for each intent:

```
auto         auto/coding    auto/fast
auto/cheap   auto/offline   auto/smart   auto/lkgp
```

## Environment Variables

| Variable | Description |
|---|---|
| `OMNIROUTE_URL` | OmniRoute server base URL |
| `OMNIROUTE_API_KEY` | API key |
| `OMNIROUTE_PROVIDER_NAME` | Provider name shown in the picker (default: `omni`) |
| `OMNIROUTE_MODE` | Routing mode: `fast`, `balanced`, `quality`, `cheap`, `reliable`, `offline`, or `default` |
| `OMNIROUTE_BUDGET` | Positive per-request USD budget |
| `OMNIROUTE_BUDGET_FALLBACK` | `strict` or `cheapest` |
| `OMNIROUTE_COMPRESSION` | Compression mode, named combo, `default`, or `off` |

Connection variables can skip `/omni setup`. Routing environment variables override saved settings.

## Development

```bash
npm run typecheck   # tsc — zero errors expected
npm run smoke       # import check for omp.ts and pi.ts
```

| File | Purpose |
|---|---|
| `shared.ts` | All business logic — no host package imports; works in both `pi` and `omp` |
| `omp.ts` | Oh My Pi entry point — `OMP_HOME` / `~/.omp/agent` |
| `pi.ts` | Pi Coding Agent entry point — `PI_HOME` / `~/.pi/agent` |

## Requirements

- `omp` ([`@oh-my-pi/pi-coding-agent`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)) v15.9.0+ **or** `pi` ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) v0.60.0+
- [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — any version exposing `/v1/models` and `/v1/chat/completions`

## License

MIT
