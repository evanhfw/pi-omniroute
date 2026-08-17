# Contributing

## Quick Start

```bash
npm install
npm run typecheck
npm run smoke
```

## Development Scripts

| Command | Purpose |
|---|---|
| `npm run typecheck` | Type-check `shared.ts`, `omp.ts`, and `pi.ts` with NodeNext settings. |
| `npm run smoke` | Import both host adapter modules and verify they load. |

## Local Pi Testing

From this repo:

```bash
pi -e ./pi.ts
```

Or install normally:

```bash
pi install git:github.com/md-riaz/omniroute-agent-extension
```

Then in Pi:

```text
/omni setup
/omni sync
/model auto/coding
/omni route fast
/omni last
```

## Before Opening a PR

Run:

```bash
npm run typecheck
npm run smoke
```

Check working tree:

```bash
git status --short
git diff --stat
```

## Documentation Rules

If changing user-visible behavior, update `README.md`.

If changing architecture or core data flow, update `ARCHITECTURE.md`.

If changing function names or scan paths, update `AI.md` so future AI agents do not waste tokens rediscovering the repo.

## Coding Rules

- Keep host-neutral behavior in `shared.ts`; adapters should remain thin.
- Add short comments for non-obvious functions.
- Preserve `/model` UX; do not add duplicate providers.
- Keep `omni` as the default provider name while respecting its config/env override.
- Scope provider request/response hooks to the configured OmniRoute provider.
- Never expose the API key in command output or tool details.
- Avoid destructive behavior in `/omni sync`; it should only replace the configured provider entry.

## Testing Checklist

For model sync changes:

- `/omni setup` saves URL/API key.
- `/omni sync` writes models to the correct host `models.json`.
- Existing unrelated providers remain intact.
- Native model streaming and tool calls still use `openai-completions`.

For routing/telemetry changes:

- Hooks ignore non-OmniRoute models.
- Session, mode, budget, fallback, and compression headers follow config.
- `/omni last` handles both complete and missing response headers.
- No command, tool result, or status output exposes the API key.
- `npm run typecheck` and `npm run smoke` pass.

## Commit Style

Use descriptive commit messages. Good examples:

```text
Add per-request budget controls for OmniRoute
Show OmniRoute response telemetry in Pi
Preserve unrelated providers during model sync
```
