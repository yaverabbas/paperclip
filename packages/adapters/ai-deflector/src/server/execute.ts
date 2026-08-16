import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { appendAudit } from "./audit.js";
import { defaultAuditPath, defaultKbPath, matchIssue, type PatternRule } from "./match.js";
import { loadPatterns, openKb, seedKbIfEmpty } from "./kb.js";

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function resolveApiBase(config: Record<string, unknown>, context: Record<string, unknown>): string {
  const fromConfig = asString(config.apiBaseUrl, "").replace(/\/+$/, "");
  if (fromConfig) return fromConfig;
  const fromEnv = (process.env.PAPERCLIP_API_URL ?? "").replace(/\/+$/, "").replace(/\/api$/, "");
  if (fromEnv) return fromEnv;
  const fromContext = asString(context.apiBaseUrl, "").replace(/\/+$/, "");
  return fromContext || "http://127.0.0.1:3100";
}

async function apiFetch(
  base: string,
  path: string,
  opts: {
    method?: string;
    token?: string;
    runId?: string;
    body?: unknown;
  },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.runId) headers["X-Paperclip-Run-Id"] = opts.runId;

  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

function renderComment(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

const UUID_RE = /^[0-9a-f-]{36}$/i;
const FALLBACK_COMMENT =
  "AI Deflector: no pattern matched — please assign this task to the appropriate person.";

export async function resolveAgentId(
  base: string,
  companyId: string,
  slugOrId: string,
  token: string,
  runId: string,
): Promise<string | null> {
  if (UUID_RE.test(slugOrId)) return slugOrId;

  const res = await apiFetch(base, `/api/companies/${companyId}/agents`, { token, runId });
  if (!res.ok || !Array.isArray(res.json)) return null;
  const agents = res.json as Array<{ id: string; role?: string; name?: string }>;
  const match = agents.find(
    (a) =>
      (a.role ?? "").toLowerCase() === slugOrId.toLowerCase() ||
      (a.name ?? "").toLowerCase() === slugOrId.toLowerCase(),
  );
  return match?.id ?? null;
}

async function patchIssueAssignee(
  base: string,
  issueId: string,
  assigneeAgentId: string,
  comment: string,
  token: string,
  runId: string,
): Promise<{ ok: boolean; status: number }> {
  const res = await apiFetch(base, `/api/issues/${issueId}`, {
    method: "PATCH",
    token,
    runId,
    body: { assigneeAgentId, comment },
  });
  return { ok: res.ok, status: res.status };
}

async function runHubScan(opts: {
  base: string;
  companyId: string;
  agentId: string;
  fallbackAgentId: string;
  token: string;
  runId: string;
  kbPath: string;
  auditPath: string;
  dryRun: boolean;
  onLog: AdapterExecutionContext["onLog"];
}): Promise<{ processed: number; routed: number; resolved: number; fallback: number; errors: number }> {
  const {
    base,
    companyId,
    agentId,
    fallbackAgentId: fallbackRaw,
    token,
    runId,
    kbPath,
    auditPath,
    dryRun,
    onLog,
  } = opts;

  const db = openKb(kbPath);
  let patterns: PatternRule[];
  try {
    seedKbIfEmpty(db);
    patterns = loadPatterns(db);
  } finally {
    db.close();
  }

  let fallbackAgentId = fallbackRaw;
  if (fallbackAgentId && !UUID_RE.test(fallbackAgentId)) {
    const resolved = await resolveAgentId(base, companyId, fallbackAgentId, token, runId);
    if (!resolved) {
      await onLog("stderr", `Hub scan: cannot resolve fallbackAgentId="${fallbackAgentId}"\n`);
      fallbackAgentId = "";
    } else {
      fallbackAgentId = resolved;
    }
  }

  const listRes = await apiFetch(
    base,
    `/api/companies/${companyId}/issues?assigneeAgentId=null&status=todo&excludeRoutineExecutions=true&excludePluginOperations=true&limit=50`,
    { token, runId },
  );
  if (!listRes.ok) {
    await onLog("stderr", `Hub scan: failed to list issues (HTTP ${listRes.status})\n`);
    return { processed: 0, routed: 0, resolved: 0, fallback: 0, errors: 1 };
  }
  const body = listRes.json as { issues?: unknown[] } | unknown[];
  const issues = (Array.isArray(body) ? body : (body as { issues?: unknown[] }).issues ?? []) as Record<
    string,
    unknown
  >[];

  await onLog("stdout", `Hub scan: found ${issues.length} unassigned todo issue(s)\n`);

  let routed = 0;
  let resolved = 0;
  let fallback = 0;
  let errors = 0;

  for (const issue of issues) {
    const issueId = asString(issue.id, "");
    const identifier = asString(issue.identifier, "") || issueId;
    if (!issueId) continue;

    const issueRes = await apiFetch(base, `/api/issues/${issueId}`, { token, runId });
    if (!issueRes.ok || !issueRes.json || typeof issueRes.json !== "object") {
      await onLog("stderr", `Hub scan: failed to fetch issue ${identifier}\n`);
      errors++;
      continue;
    }
    const fullIssue = issueRes.json as Record<string, unknown>;
    const originId = asString(fullIssue.originId, "") || null;
    let originStatus: string | null = null;
    if (originId) {
      const originRes = await apiFetch(base, `/api/issues/${originId}`, { token, runId });
      if (originRes.ok && originRes.json && typeof originRes.json === "object") {
        originStatus = asString((originRes.json as Record<string, unknown>).status, "") || null;
      }
    }

    const match = matchIssue(patterns, {
      issue: {
        id: issueId,
        identifier: asString(fullIssue.identifier, "") || null,
        title: asString(fullIssue.title, ""),
        description: asString(fullIssue.description, "") || null,
        originKind: asString(fullIssue.originKind, "") || null,
        originId,
        companyId,
        status: asString(fullIssue.status, "") || null,
      },
      originStatus,
    });

    await onLog("stdout", `Hub scan: ${identifier} -> ${match.reason}\n`);

    if (match.matched && match.pattern) {
      const pattern = match.pattern;

      if (pattern.routeToAgent) {
        const targetId = await resolveAgentId(base, companyId, pattern.routeToAgent, token, runId);
        if (!targetId) {
          await onLog(
            "stderr",
            `Hub scan: cannot resolve routeToAgent="${pattern.routeToAgent}" for ${identifier}\n`,
          );
          errors++;
          continue;
        }
        const comment = renderComment(pattern.commentTemplate, {
          originStatus: originStatus ?? "unknown",
          patternId: pattern.id,
          issueIdentifier: identifier,
        });
        if (!dryRun) {
          const r = await patchIssueAssignee(base, issueId, targetId, comment, token, runId);
          if (!r.ok) {
            await onLog("stderr", `Hub scan: route PATCH failed HTTP ${r.status} for ${identifier}\n`);
            appendAudit(auditPath, {
              ts: new Date().toISOString(),
              runId,
              agentId,
              companyId,
              issueId,
              issueIdentifier: identifier,
              matched: true,
              patternId: pattern.id,
              confidence: pattern.confidence,
              reason: `route PATCH failed HTTP ${r.status}`,
              action: "error",
              detail: { routeToAgent: pattern.routeToAgent, targetId },
            });
            errors++;
            continue;
          }
        }
        appendAudit(auditPath, {
          ts: new Date().toISOString(),
          runId,
          agentId,
          companyId,
          issueId,
          issueIdentifier: identifier,
          matched: true,
          patternId: pattern.id,
          confidence: pattern.confidence,
          reason: match.reason,
          action: dryRun ? "dry_run" : "routed",
          detail: { routeToAgent: pattern.routeToAgent, targetId },
        });
        routed++;
      } else {
        const comment = renderComment(pattern.commentTemplate, {
          originStatus: originStatus ?? "unknown",
          patternId: pattern.id,
          issueIdentifier: identifier,
        });
        if (!dryRun) {
          const r = await apiFetch(base, `/api/issues/${issueId}`, {
            method: "PATCH",
            token,
            runId,
            body: { status: pattern.resolutionStatus, comment },
          });
          if (!r.ok) {
            await onLog("stderr", `Hub scan: resolve PATCH failed HTTP ${r.status} for ${identifier}\n`);
            appendAudit(auditPath, {
              ts: new Date().toISOString(),
              runId,
              agentId,
              companyId,
              issueId,
              issueIdentifier: identifier,
              matched: true,
              patternId: pattern.id,
              confidence: pattern.confidence,
              reason: `resolve PATCH failed HTTP ${r.status}`,
              action: "error",
              detail: { status: pattern.resolutionStatus },
            });
            errors++;
            continue;
          }
        }
        appendAudit(auditPath, {
          ts: new Date().toISOString(),
          runId,
          agentId,
          companyId,
          issueId,
          issueIdentifier: identifier,
          matched: true,
          patternId: pattern.id,
          confidence: pattern.confidence,
          reason: match.reason,
          action: dryRun ? "dry_run" : "resolved",
          detail: { status: pattern.resolutionStatus },
        });
        resolved++;
      }
    } else {
      if (!fallbackAgentId) {
        await onLog(
          "stderr",
          `Hub scan: no match for ${identifier} but fallbackAgentId is not configured; skipping\n`,
        );
        appendAudit(auditPath, {
          ts: new Date().toISOString(),
          runId,
          agentId,
          companyId,
          issueId,
          issueIdentifier: identifier,
          matched: false,
          patternId: null,
          confidence: null,
          reason: match.reason,
          action: "skipped",
          detail: { missingFallback: true },
        });
        continue;
      }
      if (!dryRun) {
        const r = await patchIssueAssignee(base, issueId, fallbackAgentId, FALLBACK_COMMENT, token, runId);
        if (!r.ok) {
          await onLog("stderr", `Hub scan: fallback PATCH failed HTTP ${r.status} for ${identifier}\n`);
          appendAudit(auditPath, {
            ts: new Date().toISOString(),
            runId,
            agentId,
            companyId,
            issueId,
            issueIdentifier: identifier,
            matched: false,
            patternId: null,
            confidence: null,
            reason: `fallback PATCH failed HTTP ${r.status}`,
            action: "error",
            detail: { fallbackAgentId },
          });
          errors++;
          continue;
        }
      }
      appendAudit(auditPath, {
        ts: new Date().toISOString(),
        runId,
        agentId,
        companyId,
        issueId,
        issueIdentifier: identifier,
        matched: false,
        patternId: null,
        confidence: null,
        reason: match.reason,
        action: dryRun ? "dry_run" : "fallback",
        detail: { fallbackAgentId },
      });
      fallback++;
    }
  }

  return { processed: issues.length, routed, resolved, fallback, errors };
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, config, context, onLog, onMeta, authToken } = ctx;
  const kbPath = asString(config.kbPath, defaultKbPath());
  const auditPath = asString(config.auditPath, defaultAuditPath());
  const dryRun = asBoolean(config.dryRun, false);
  const hubMode = asBoolean(config.hubMode, false);
  const fallbackAgentId = asString(config.fallbackAgentId, "");
  const apiBase = resolveApiBase(config, context);

  if (onMeta) {
    await onMeta({
      adapterType: "ai_deflector_local",
      command: "ai-deflector-match",
      cwd: process.cwd(),
      commandArgs: [],
      env: {
        PAPERCLIP_RUN_ID: runId,
        AI_DEFLECTOR_KB_PATH: kbPath,
        AI_DEFLECTOR_DRY_RUN: dryRun ? "1" : "0",
        AI_DEFLECTOR_HUB_MODE: hubMode ? "1" : "0",
      },
    });
  }

  const paperclipIssue = parseObject(context.paperclipIssue);
  const issueId =
    asString(paperclipIssue.id, "") ||
    asString(context.issueId, "") ||
    asString(context.taskId, "");

  const token = authToken || process.env.PAPERCLIP_API_KEY || "";
  if (!token) {
    await onLog("stderr", "AI Deflector: missing API token; refusing to act.\n");
    appendAudit(auditPath, {
      ts: new Date().toISOString(),
      runId,
      agentId: agent.id,
      companyId: agent.companyId,
      issueId: issueId || null,
      issueIdentifier: asString(paperclipIssue.identifier, "") || null,
      matched: false,
      patternId: null,
      confidence: null,
      reason: "missing API token",
      action: "error",
    });
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "AI Deflector missing API token",
      errorCode: "ai_deflector_auth_missing",
    };
  }

  if (!issueId) {
    if (hubMode) {
      await onLog("stdout", "AI Deflector hub scan starting...\n");
      const stats = await runHubScan({
        base: apiBase,
        companyId: agent.companyId,
        agentId: agent.id,
        fallbackAgentId,
        token,
        kbPath,
        auditPath,
        dryRun,
        runId,
        onLog,
      });
      await onLog("stdout", `Hub scan done: ${JSON.stringify(stats)}\n`);
      return {
        exitCode: stats.errors > 0 ? 1 : 0,
        signal: null,
        timedOut: false,
        summary: `AI Deflector hub scan: processed=${stats.processed} routed=${stats.routed} resolved=${stats.resolved} fallback=${stats.fallback} errors=${stats.errors}`,
        resultJson: stats,
      };
    }
    await onLog("stdout", "AI Deflector: no assigned issue in context; nothing to check.\n");
    appendAudit(auditPath, {
      ts: new Date().toISOString(),
      runId,
      agentId: agent.id,
      companyId: agent.companyId,
      issueId: null,
      issueIdentifier: null,
      matched: false,
      patternId: null,
      confidence: null,
      reason: "no issue in context",
      action: "skipped",
    });
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: "AI Deflector skipped (no issue context)",
    };
  }

  const issueRes = await apiFetch(apiBase, `/api/issues/${issueId}`, { token, runId });
  if (!issueRes.ok || !issueRes.json || typeof issueRes.json !== "object") {
    await onLog("stderr", `AI Deflector: failed to load issue ${issueId} (HTTP ${issueRes.status}).\n`);
    appendAudit(auditPath, {
      ts: new Date().toISOString(),
      runId,
      agentId: agent.id,
      companyId: agent.companyId,
      issueId,
      issueIdentifier: null,
      matched: false,
      patternId: null,
      confidence: null,
      reason: `GET issue failed HTTP ${issueRes.status}`,
      action: "error",
    });
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: `Failed to load issue ${issueId}`,
      errorCode: "ai_deflector_issue_fetch_failed",
    };
  }

  const issue = issueRes.json as Record<string, unknown>;
  const originId = asString(issue.originId, "") || null;
  let originStatus: string | null = null;
  if (originId) {
    const originRes = await apiFetch(apiBase, `/api/issues/${originId}`, { token, runId });
    if (originRes.ok && originRes.json && typeof originRes.json === "object") {
      originStatus = asString((originRes.json as Record<string, unknown>).status, "") || null;
    }
  }

  const db = openKb(kbPath);
  try {
    seedKbIfEmpty(db);
    const patterns = loadPatterns(db);
    const match = matchIssue(patterns, {
      issue: {
        id: asString(issue.id, issueId),
        identifier: asString(issue.identifier, "") || null,
        title: asString(issue.title, asString(paperclipIssue.title, "")),
        description: asString(issue.description, "") || null,
        originKind: asString(issue.originKind, "") || null,
        originId,
        companyId: asString(issue.companyId, agent.companyId) || null,
        status: asString(issue.status, "") || null,
      },
      originStatus,
    });

    await onLog(
      "stdout",
      `AI Deflector: issue=${asString(issue.identifier, issueId)} originKind=${asString(issue.originKind, "-")} originStatus=${originStatus ?? "-"} -> ${match.reason}\n`,
    );

    if (!match.matched || !match.pattern) {
      // Spec: no match → do nothing. Heartbeat only continues work for issues
      // with a non-null assignee; clearing assigneeAgentId would orphan the
      // ticket. Routing/reassignment is an operator concern outside this adapter
      // unless hubMode is enabled (handled above when there is no assigned issue).
      appendAudit(auditPath, {
        ts: new Date().toISOString(),
        runId,
        agentId: agent.id,
        companyId: agent.companyId,
        issueId,
        issueIdentifier: asString(issue.identifier, "") || null,
        matched: false,
        patternId: null,
        confidence: null,
        reason: match.reason,
        action: dryRun ? "dry_run" : "skipped",
        detail: { originKind: issue.originKind, originStatus },
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: `AI Deflector pass-through: ${match.reason}`,
        resultJson: { matched: false, reason: match.reason },
      };
    }

    const pattern = match.pattern;
    const comment = renderComment(pattern.commentTemplate, {
      originStatus: originStatus ?? "unknown",
      patternId: pattern.id,
      issueIdentifier: asString(issue.identifier, issueId),
    });

    if (dryRun) {
      appendAudit(auditPath, {
        ts: new Date().toISOString(),
        runId,
        agentId: agent.id,
        companyId: agent.companyId,
        issueId,
        issueIdentifier: asString(issue.identifier, "") || null,
        matched: true,
        patternId: pattern.id,
        confidence: pattern.confidence,
        reason: match.reason,
        action: "dry_run",
        detail: { wouldStatus: pattern.resolutionStatus, comment },
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: `AI Deflector dry-run match: ${pattern.id}`,
        resultJson: { matched: true, patternId: pattern.id, dryRun: true },
      };
    }

    const patch = await apiFetch(apiBase, `/api/issues/${issueId}`, {
      method: "PATCH",
      token,
      runId,
      body: {
        status: pattern.resolutionStatus,
        comment,
      },
    });

    if (!patch.ok) {
      await onLog("stderr", `AI Deflector: PATCH failed HTTP ${patch.status}\n`);
      appendAudit(auditPath, {
        ts: new Date().toISOString(),
        runId,
        agentId: agent.id,
        companyId: agent.companyId,
        issueId,
        issueIdentifier: asString(issue.identifier, "") || null,
        matched: true,
        patternId: pattern.id,
        confidence: pattern.confidence,
        reason: `PATCH failed HTTP ${patch.status}`,
        action: "error",
      });
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: `AI Deflector PATCH failed HTTP ${patch.status}`,
        errorCode: "ai_deflector_patch_failed",
      };
    }

    appendAudit(auditPath, {
      ts: new Date().toISOString(),
      runId,
      agentId: agent.id,
      companyId: agent.companyId,
      issueId,
      issueIdentifier: asString(issue.identifier, "") || null,
      matched: true,
      patternId: pattern.id,
      confidence: pattern.confidence,
      reason: match.reason,
      action: "resolved",
      detail: { status: pattern.resolutionStatus, originStatus },
    });

    await onLog("stdout", `AI Deflector: resolved via ${pattern.id}\n`);
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `AI Deflector resolved: ${pattern.id}`,
      resultJson: {
        matched: true,
        patternId: pattern.id,
        status: pattern.resolutionStatus,
      },
    };
  } finally {
    db.close();
  }
}
