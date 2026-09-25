# Architecture

## Overview

The package exposes two thin host adapters and one shared implementation:

```text
pi.ts ──┐
        ├──> shared.ts ──> OmniRoute
omp.ts ─┘
```

- `pi.ts` selects `PI_HOME` / `~/.pi/agent`.
- `omp.ts` selects `OMP_HOME` / `~/.omp/agent`.
- `shared.ts` owns configuration, discovery, provider registration, commands, tools, request headers, health checks, and telemetry.

The adapters import their host's `ExtensionAPI`; `shared.ts` deliberately has no host-package imports.

## Setup and Model Sync

```text
/omni setup or /omni sync
  -> GET {serverUrl}/v1/models
  -> discard non-chat/image-only entries
  -> normalize text/image, context, output, reasoning, and effort-tier metadata
  -> prepend missing auto/* virtual models
  -> apply config `modelOverrides` (per-model patches for metadata the endpoint omits)
  -> register an openai-completions provider
  -> merge that provider into the host models.json
  -> refresh the model registry
```

At extension load, the saved provider is registered from `models.json` without a network call. This keeps startup fast and models available while OmniRoute is temporarily offline. Explicit setup/sync performs live discovery.

Only the configured provider key is replaced in `models.json`; unrelated providers are preserved.

Endpoint metadata is authoritative but incomplete for some models. `effort_tiers` becomes a `thinkingLevelMap` (unsupported Pi levels are hidden with `null`). Fields the endpoint omits (e.g. `max_output_tokens`, `input_modalities`) can be patched per model via `modelOverrides` in `config.json`, keyed by exact model id; each override may set `name`, `reasoning`, `thinkingLevelMap`, `input`, `contextWindow`, and `maxTokens`.

## Provider Requests

The provider uses the host's native `openai-completions` implementation:

```text
Pi context + tools
  -> host OpenAI-compatible serializer/SSE parser
  -> {serverUrl}/v1/chat/completions
  -> OmniRoute routing/fallback
  -> native text, reasoning, and tool-call stream events
```

The extension does not implement its own model stream or prompt-emulated tool protocol.

## Web Search Tool

The `omniroute_search` tool and `/omni search` call `POST {serverUrl}/v1/search` with a `query` and optional `max_results`, `provider`, and `search_type` (`web`/`news`) fields. The response is formatted as a numbered list of titles, URLs, and snippets. Search provider credentials and quota are managed server-side by OmniRoute; the extension never sees or forwards an API key.

## Routing Controls and Session Affinity

The `before_provider_headers` hook runs only when the selected model belongs to the configured OmniRoute provider. It adds:

- `X-OmniRoute-Session-Id` from the current Pi session, when available.
- `X-OmniRoute-Mode` for a non-default mode pack.
- `X-OmniRoute-Budget` and `X-OmniRoute-Budget-Fallback` when a budget is enabled.
- `X-OmniRoute-Compression` for a non-default compression selection.

Controls are persisted by `/omni route`, `/omni budget`, and `/omni compression`. Environment values override saved values.

Session affinity lets OmniRoute correlate costs by Pi session and improves sticky routing/prompt-cache affinity without exposing conversation content in the header.

## Response Telemetry

`after_provider_response` captures available `X-OmniRoute-*` headers for OmniRoute requests only:

```text
request/model/provider/decision
latency/cost/tokens/cache/fallbacks
compression/version
```

The latest in-memory snapshot powers `/omni last`, the `omniroute_status` tool details, and a compact status-bar route summary. It is cleared at session shutdown and never persisted. Streaming transports may expose only headers known when the HTTP response starts; absent values are displayed as not reported.

## Configuration

Saved configuration lives at:

```text
<agent-home>/omniroute-agent-extension/config.json
```

The synced provider lives in:

```text
<agent-home>/models.json
```

Configuration is sanitized on every read. Missing fields from older releases receive defaults, invalid routing modes fall back to `default`, and non-positive budgets are disabled. API keys are never shown by commands or returned in tool details.

## Lifecycle

- Factory: load config and register the cached provider; do not start background work.
- `session_start`: check reachability and start one health interval.
- `model_select`: show the selected OmniRoute model or clear OmniRoute status for another provider.
- Provider hooks: apply headers and capture telemetry only for OmniRoute.
- `session_shutdown`: clear the health interval and telemetry.

## Extension Boundaries

This package does not manage OmniRoute providers, combos, or gateway state. It consumes the public OpenAI-compatible model/chat API and documented request/response headers. OmniRoute remains responsible for routing, budgets, compression, caching, fallback, usage accounting, and upstream credentials.
