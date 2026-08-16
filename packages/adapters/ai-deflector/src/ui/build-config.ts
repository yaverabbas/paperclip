export function buildAiDeflectorConfig(values: Record<string, unknown>): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  const kbPath = typeof values.kbPath === "string" ? values.kbPath.trim() : "";
  const auditPath = typeof values.auditPath === "string" ? values.auditPath.trim() : "";
  const fallbackAgentId =
    typeof values.fallbackAgentId === "string" ? values.fallbackAgentId.trim() : "";
  if (kbPath) ac.kbPath = kbPath;
  if (auditPath) ac.auditPath = auditPath;
  if (values.dryRun === true) ac.dryRun = true;
  if (values.hubMode === true) ac.hubMode = true;
  if (fallbackAgentId) ac.fallbackAgentId = fallbackAgentId;
  return ac;
}
