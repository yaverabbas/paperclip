export const type = "ai_deflector_local";
export const label = "AI Deflector";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# ai_deflector_local agent configuration

Adapter: ai_deflector_local

Non-AI pre-check adapter. Matches issues against a deterministic SQLite pattern
KB. No embeddings, no vector DB, no LLM.

Use when:
- A company needs a first look at unassigned todos (hubMode) or assigned
  tickets, and should auto-resolve only high-confidence repeats
- You want deterministic routing to a named agent via route_to_agent, or
  fallback assignment to the CEO when nothing matches

Don't use when:
- The agent should do original work (use a local CLI / HTTP adapter)
- You need LLM classification or fuzzy matching
- The company has not granted the Deflector agent company issue list +
  tasks:assign (hub mode PATCH will fail)

Core fields:
- kbPath (string, optional): absolute path to kb.sqlite
  Default: ~/.paperclip/instances/default/ai-deflector/kb.sqlite
- auditPath (string, optional): absolute path to audit log JSONL
  Default: ~/.paperclip/instances/default/ai-deflector/audit.jsonl
- dryRun (boolean, optional, default false): match and log only, never PATCH
- apiBaseUrl (string, optional): override Paperclip API base URL
- hubMode (boolean, optional, default false): when true and the heartbeat has
  no assigned issue, scan unassigned company todo issues (up to 50), match
  against the KB, then either auto-resolve, route via route_to_agent, or
  assign to fallbackAgentId
- fallbackAgentId (string, optional): CEO (or other fallback) agent UUID or
  slug ("ceo"). Required for hub-mode unmatched issues. Unmatched issues are
  assigned with a fixed comment asking the fallback agent to reassign.

Notes:
- Bias is toward doing nothing. Uncertain matches are skipped.
- No embeddings, no vector DB, no LLM.
- Existing patterns keep route_to_agent NULL (auto-resolve). Set route_to_agent
  on a pattern to assign instead of closing.
`;
