import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { defaultAuditPath, defaultKbPath } from "./match.js";
import { loadPatterns, openKb, seedKbIfEmpty } from "./kb.js";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const kbPath = asString(config.kbPath, defaultKbPath());
  const auditPath = asString(config.auditPath, defaultAuditPath());
  const hubMode = asBoolean(config.hubMode, false);
  const fallbackAgentId = asString(config.fallbackAgentId, "");

  checks.push({
    code: "ai_deflector_kb_path",
    level: "info",
    message: `KB path: ${kbPath}`,
  });
  checks.push({
    code: "ai_deflector_audit_path",
    level: "info",
    message: `Audit path: ${auditPath}`,
  });
  checks.push({
    code: "ai_deflector_hub_mode",
    level: "info",
    message: hubMode ? "Hub mode: enabled" : "Hub mode: disabled",
  });
  if (hubMode && !fallbackAgentId) {
    checks.push({
      code: "ai_deflector_hub_fallback_missing",
      level: "warn",
      message: "hubMode is enabled but fallbackAgentId is empty; unmatched issues will be skipped.",
      hint: "Set fallbackAgentId to the CEO UUID or slug (ceo).",
    });
  } else if (hubMode) {
    checks.push({
      code: "ai_deflector_hub_fallback",
      level: "info",
      message: `Hub fallback agent: ${fallbackAgentId}`,
    });
  }

  try {
    const db = openKb(kbPath);
    try {
      const seeded = seedKbIfEmpty(db);
      const patterns = loadPatterns(db);
      checks.push({
        code: "ai_deflector_kb_readable",
        level: "info",
        message: `KB OK (${patterns.length} enabled patterns${seeded ? `, seeded ${seeded}` : ""})`,
      });
      if (patterns.length === 0) {
        checks.push({
          code: "ai_deflector_kb_empty",
          level: "warn",
          message: "KB has zero enabled patterns; AI Deflector will never auto-resolve.",
        });
      }
    } finally {
      db.close();
    }
  } catch (err) {
    checks.push({
      code: "ai_deflector_kb_error",
      level: "error",
      message: err instanceof Error ? err.message : "Failed to open KB",
      detail: kbPath,
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
