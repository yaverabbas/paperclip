# AI Deflector (`ai_deflector_local`)

Non-AI pre-check adapter. Deterministic keyword/regex matching against a SQLite KB.
Auto-resolves only high-confidence repeat issues. In hub mode it is the company
entry point for unassigned `todo` issues: match and resolve, match and route, or
fallback-assign to the CEO.

Spec: `doc/plans/ai-deflector-hub-mode.md`

## Layout

- `src/server/execute.ts` — heartbeat execution and hub scan
- `src/server/match.ts` — matching engine
- `src/server/kb.ts` — SQLite KB (`better-sqlite3`, Node 20 compatible)
- `src/server/audit.ts` — JSONL audit log
- `scripts/seed-kb.ts` — manual/cron seed (not in live request path)

## Defaults

- KB: `~/.paperclip/instances/default/ai-deflector/kb.sqlite`
- Audit: `~/.paperclip/instances/default/ai-deflector/audit.jsonl`
- `hubMode`: `false` (assigned-issue path only, existing behaviour)
- Seed patterns keep `route_to_agent` NULL (auto-resolve)

## Hub mode

On a timer heartbeat with **no assigned issue**, set `hubMode: true` and
`fallbackAgentId` (CEO UUID or slug `ceo`). Each scan processes up to 50
unassigned company `todo` issues:

| Result | Action |
|---|---|
| High-confidence match, `route_to_agent` set | PATCH assignee to that agent |
| High-confidence match, `route_to_agent` null | Auto-resolve (`done`/`cancelled`) |
| No match | PATCH assignee to `fallbackAgentId` with a fixed CEO comment |

Hub mode uses no LLM. After deploy, enable it per company on the AI Deflector
agent config form. The Deflector agent also needs a timer heartbeat (~300s)
and permission to list company issues and assign tasks.

## Seed

```bash
pnpm --filter @paperclipai/adapter-ai-deflector seed:kb
```
