export const type = "ai_deflector_local";
export const label = "AI Deflector";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# ai_deflector_local agent configuration

Adapter: ai_deflector_local

Non-AI pre-check adapter. Matches assigned issues against a deterministic
SQLite pattern KB and auto-resolves only high-confidence repeats.

Core fields:
- kbPath (string, optional): absolute path to kb.sqlite
  Default: ~/.paperclip/instances/default/ai-deflector/kb.sqlite
- auditPath (string, optional): absolute path to audit log JSONL
  Default: ~/.paperclip/instances/default/ai-deflector/audit.jsonl
- dryRun (boolean, optional, default false): match and log only, never PATCH
- apiBaseUrl (string, optional): override Paperclip API base URL

Notes:
- High-confidence matches auto-resolve as before.
- No-match assigned issues are commented, reassigned to the CEO fallback
  agent, and set back to todo so they are not left blocked.
- No embeddings, no vector DB, no LLM.
`;
