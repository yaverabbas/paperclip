import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SEED_PATTERNS } from "./match.js";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const openKb = vi.fn((_kbPath: string) => ({ close: () => {} }));
const seedKbIfEmpty = vi.fn((_db: unknown, _patterns?: unknown) => 0);
const loadPatterns = vi.fn((_db: unknown) => SEED_PATTERNS);

vi.mock("./kb.js", () => ({
  openKb: (kbPath: string) => openKb(kbPath),
  seedKbIfEmpty: (db: unknown, patterns?: unknown) => seedKbIfEmpty(db, patterns),
  loadPatterns: (db: unknown) => loadPatterns(db),
  upsertPatterns: vi.fn(),
}));

import { execute } from "./execute.js";

function makeCtx(overrides: {
  kbPath: string;
  auditPath: string;
  issueId?: string;
  dryRun?: boolean;
  hubMode?: boolean;
  fallbackAgentId?: string;
}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "AI Deflector", adapterType: "ai_deflector_local" } as never,
    runtime: {} as never,
    config: {
      kbPath: overrides.kbPath,
      auditPath: overrides.auditPath,
      dryRun: overrides.dryRun ?? false,
      apiBaseUrl: "http://test.local",
      hubMode: overrides.hubMode ?? false,
      fallbackAgentId: overrides.fallbackAgentId ?? "",
    },
    context: {
      paperclipIssue: overrides.issueId
        ? { id: overrides.issueId, identifier: "AIP-1", title: "Recover stalled issue AIP-9" }
        : undefined,
    },
    onLog: async () => {},
    authToken: "test-token",
  };
}

const CEO_ID = "11111111-1111-4111-8111-111111111111";
const PM_ID = "22222222-2222-4222-8222-222222222222";

describe("execute", () => {
  beforeEach(() => {
    openKb.mockReturnValue({ close: () => {} });
    seedKbIfEmpty.mockReturnValue(0);
    loadPatterns.mockReturnValue(SEED_PATTERNS);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("resolves when pattern matches and origin is terminal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-deflector-ex-"));
    const kbPath = join(dir, "kb.sqlite");
    const auditPath = join(dir, "audit.jsonl");
    writeFileSync(auditPath, "");

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/issues/issue-1") && (!init || init.method === "GET" || !init.method)) {
        return new Response(
          JSON.stringify({
            id: "issue-1",
            identifier: "AIP-1",
            title: "Recover stalled issue AIP-9",
            originKind: "stranded_issue_recovery",
            originId: "origin-1",
            companyId: "co-1",
            status: "todo",
          }),
          { status: 200 },
        );
      }
      if (u.endsWith("/api/issues/origin-1")) {
        return new Response(JSON.stringify({ id: "origin-1", status: "done" }), { status: 200 });
      }
      if (u.endsWith("/api/issues/issue-1") && init?.method === "PATCH") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await execute(makeCtx({ kbPath, auditPath, issueId: "issue-1" }));
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("stranded_issue_recovery_source_terminal");
      const patchCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH");
      expect(patchCalls.length).toBe(1);
      const body = JSON.parse(String(patchCalls[0]![1]!.body));
      expect(body.status).toBe("done");
      expect(body.comment).toContain("stranded_issue_recovery_source_terminal");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing (no PATCH) when no pattern matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-deflector-ex-"));
    const kbPath = join(dir, "kb.sqlite");
    const auditPath = join(dir, "audit.jsonl");
    writeFileSync(auditPath, "");

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/issues/") && (!init || !init.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({
            id: "issue-2",
            identifier: "AIP-2",
            title: "Investigate conversion drop",
            originKind: "manual",
            originId: null,
            companyId: "co-1",
            status: "todo",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await execute(
        makeCtx({
          kbPath,
          auditPath,
          issueId: "issue-2",
        }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("pass-through");
      const mutating = fetchMock.mock.calls.filter(
        (c) => c[1]?.method && c[1].method !== "GET",
      );
      expect(mutating).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hub mode resolves matching unassigned todos and fallback-assigns the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-deflector-hub-"));
    const kbPath = join(dir, "kb.sqlite");
    const auditPath = join(dir, "audit.jsonl");
    writeFileSync(auditPath, "");

    const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/issues?") && (!init || !init.method || init.method === "GET")) {
        return new Response(
          JSON.stringify([
            {
              id: "issue-match",
              identifier: "AIP-10",
              title: "Recover stalled issue AIP-9",
            },
            {
              id: "issue-miss",
              identifier: "AIP-11",
              title: "Ship new landing page",
            },
          ]),
          { status: 200 },
        );
      }
      if (u.endsWith("/api/issues/issue-match") && (!init || !init.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({
            id: "issue-match",
            identifier: "AIP-10",
            title: "Recover stalled issue AIP-9",
            originKind: "stranded_issue_recovery",
            originId: "origin-1",
            companyId: "co-1",
            status: "todo",
          }),
          { status: 200 },
        );
      }
      if (u.endsWith("/api/issues/issue-miss") && (!init || !init.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({
            id: "issue-miss",
            identifier: "AIP-11",
            title: "Ship new landing page",
            originKind: "manual",
            originId: null,
            companyId: "co-1",
            status: "todo",
          }),
          { status: 200 },
        );
      }
      if (u.endsWith("/api/issues/origin-1")) {
        return new Response(JSON.stringify({ id: "origin-1", status: "done" }), { status: 200 });
      }
      if (init?.method === "PATCH") {
        patches.push({ url: u, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await execute(
        makeCtx({ kbPath, auditPath, hubMode: true, fallbackAgentId: CEO_ID }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.summary).toContain("resolved=1");
      expect(result.summary).toContain("fallback=1");
      expect(result.resultJson).toMatchObject({
        processed: 2,
        routed: 0,
        resolved: 1,
        fallback: 1,
        errors: 0,
      });
      expect(patches).toHaveLength(2);
      expect(patches[0]?.body.status).toBe("done");
      expect(patches[1]?.body.assigneeAgentId).toBe(CEO_ID);
      expect(patches[1]?.body.comment).toContain("no pattern matched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hub mode routes matched issues to routeToAgent instead of resolving", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-deflector-hub-route-"));
    const kbPath = join(dir, "kb.sqlite");
    const auditPath = join(dir, "audit.jsonl");
    writeFileSync(auditPath, "");

    loadPatterns.mockReturnValue([
      {
        ...SEED_PATTERNS[0]!,
        routeToAgent: "product-manager",
        commentTemplate: "Routed by AI Deflector (pattern: {{patternId}}).",
      },
    ]);

    const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/companies/co-1/agents")) {
        return new Response(
          JSON.stringify([
            { id: CEO_ID, role: "ceo", name: "CEO" },
            { id: PM_ID, role: "pm", name: "product-manager" },
          ]),
          { status: 200 },
        );
      }
      if (u.includes("/issues?") && (!init || !init.method || init.method === "GET")) {
        return new Response(
          JSON.stringify([{ id: "issue-route", identifier: "AIP-12", title: "Recover stalled issue AIP-9" }]),
          { status: 200 },
        );
      }
      if (u.endsWith("/api/issues/issue-route") && (!init || !init.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({
            id: "issue-route",
            identifier: "AIP-12",
            title: "Recover stalled issue AIP-9",
            originKind: "stranded_issue_recovery",
            originId: "origin-1",
            companyId: "co-1",
            status: "todo",
          }),
          { status: 200 },
        );
      }
      if (u.endsWith("/api/issues/origin-1")) {
        return new Response(JSON.stringify({ id: "origin-1", status: "done" }), { status: 200 });
      }
      if (init?.method === "PATCH") {
        patches.push({ url: u, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await execute(
        makeCtx({ kbPath, auditPath, hubMode: true, fallbackAgentId: CEO_ID }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.resultJson).toMatchObject({
        processed: 1,
        routed: 1,
        resolved: 0,
        fallback: 0,
        errors: 0,
      });
      expect(patches).toHaveLength(1);
      expect(patches[0]?.body.assigneeAgentId).toBe(PM_ID);
      expect(patches[0]?.body.status).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hub mode dry-run does not PATCH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-deflector-hub-dry-"));
    const kbPath = join(dir, "kb.sqlite");
    const auditPath = join(dir, "audit.jsonl");
    writeFileSync(auditPath, "");

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/issues?") && (!init || !init.method || init.method === "GET")) {
        return new Response(
          JSON.stringify([{ id: "issue-miss", identifier: "AIP-13", title: "Random work" }]),
          { status: 200 },
        );
      }
      if (u.includes("/api/issues/issue-miss")) {
        return new Response(
          JSON.stringify({
            id: "issue-miss",
            identifier: "AIP-13",
            title: "Random work",
            originKind: "manual",
            originId: null,
            companyId: "co-1",
            status: "todo",
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await execute(
        makeCtx({ kbPath, auditPath, hubMode: true, fallbackAgentId: CEO_ID, dryRun: true }),
      );
      expect(result.exitCode).toBe(0);
      expect(result.resultJson).toMatchObject({ fallback: 1, errors: 0 });
      expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH")).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hub mode records HTTP errors when fallback PATCH fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-deflector-hub-err-"));
    const kbPath = join(dir, "kb.sqlite");
    const auditPath = join(dir, "audit.jsonl");
    writeFileSync(auditPath, "");

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/issues?") && (!init || !init.method || init.method === "GET")) {
        return new Response(
          JSON.stringify([{ id: "issue-miss", identifier: "AIP-14", title: "Random work" }]),
          { status: 200 },
        );
      }
      if (u.includes("/api/issues/issue-miss") && (!init || !init.method || init.method === "GET")) {
        return new Response(
          JSON.stringify({
            id: "issue-miss",
            identifier: "AIP-14",
            title: "Random work",
            originKind: "manual",
            originId: null,
            companyId: "co-1",
            status: "todo",
          }),
          { status: 200 },
        );
      }
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await execute(
        makeCtx({ kbPath, auditPath, hubMode: true, fallbackAgentId: CEO_ID }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.resultJson).toMatchObject({ fallback: 0, errors: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
