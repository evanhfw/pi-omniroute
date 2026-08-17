# AGENTS.md

Instructions for AI agents working in this repository.

## Start Here

Before editing, read:

1. `AI.md` — fast project handoff and key function map.
2. `ARCHITECTURE.md` — extension data flow, routing headers, and telemetry design.
3. `README.md` — user-facing behavior and commands.
4. `CONTRIBUTING.md` — local checks and contribution rules.

## Must-Do Documentation Rule

If you change source behavior, update docs in the same change.

Use this mapping:

| Change type | Docs to update |
|---|---|
| User-visible command/setup/model behavior | `README.md` |
| Provider flow, routing headers, telemetry logic | `ARCHITECTURE.md` |
| File layout, key function names, scan paths, pitfalls | `AI.md` |
| Dev workflow, tests, contribution process | `CONTRIBUTING.md` |
| Package scripts/deps | `README.md` Development section and `CONTRIBUTING.md` if relevant |

Do not leave code/docs inconsistent.

## Core UX and Security Constraints

Keep model switching normal:

```text
/model <model-id>
```

Do not introduce duplicate providers. The default provider is `omni`, but configuration and `OMNIROUTE_PROVIDER_NAME` may override it.

Use the host's native `openai-completions` implementation for streaming and tool calls. Scope provider hooks to the configured OmniRoute provider, preserve unrelated `models.json` entries, and never expose the API key in UI or tool details.

## Test Before Reporting Done

Run:

```bash
npm run typecheck
npm run smoke
```

If tests cannot run, report exact command and failure.

## Edit Guidance

- Prefer small targeted edits.
- Keep comments on non-obvious functions.
- Preserve `/omni setup`, `/omni sync`, `/omni dashboard` behavior unless user asks to change it.
- Keep routing header and telemetry behavior documented in `ARCHITECTURE.md`.
- If adding files, update `AI.md` file map.

## Important Files

| File | Why important |
|---|---|
| `shared.ts` | Shared extension implementation. |
| `pi.ts` | Pi Coding Agent adapter. |
| `omp.ts` | Oh My Pi adapter. |
| `AI.md` | AI scan guide; update when project structure/function map changes. |
| `ARCHITECTURE.md` | Data flow and tool routing docs. |
| `README.md` | User-facing documentation. |
| `CONTRIBUTING.md` | Dev/test workflow. |
| `package.json` | Pi extension metadata and scripts. |
