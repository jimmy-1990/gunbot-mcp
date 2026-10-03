import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PROFILES, TOOL_POLICY, allowedTools, isToolAllowed, type Permission } from "../src/permissions.js";
import { PendingStore } from "../src/changes.js";
import { registerReadTools } from "../src/tools/read.js";
import { registerWriteTools } from "../src/tools/write.js";
import type { Ctx, Instance } from "../src/registry.js";

const perm = (over: Partial<Permission> = {}): Permission => ({
  profile: "read-only",
  allow: [],
  deny: [],
  flags: { strategyWrites: false, trading: false },
  ...over,
});

const expected = {
  "read-only": ["gunbot_get_config", "gunbot_get_balances", "gunbot_status"],
  config: ["gunbot_propose_pair_change", "gunbot_apply_change"],
  operator: ["gunbot_stop_core", "gunbot_start_core", "gunbot_restart_core"],
};

describe("profiles", () => {
  it("read-only exposes no write tool", () => {
    const tools = allowedTools(perm());
    for (const t of tools) expect(TOOL_POLICY[t as keyof typeof TOOL_POLICY].tier).toBe("read-only");
    for (const t of [...expected.config, ...expected.operator]) expect(tools).not.toContain(t);
  });

  it("each profile is a strict superset of the one below", () => {
    const sets = PROFILES.map((p) => new Set(allowedTools(perm({ profile: p }))));
    for (let i = 1; i < sets.length; i++) for (const t of sets[i - 1]) expect(sets[i].has(t)).toBe(true);
    expect(allowedTools(perm({ profile: "config" }))).toEqual(expect.arrayContaining(expected.config));
    expect(allowedTools(perm({ profile: "config" }))).not.toEqual(expect.arrayContaining(expected.operator));
    expect(allowedTools(perm({ profile: "operator" }))).toEqual(expect.arrayContaining(expected.operator));
  });

  it("deny always wins, even over allow and a high profile", () => {
    expect(isToolAllowed("gunbot_stop_core", perm({ profile: "full", deny: ["gunbot_stop_core"] }))).toBe(false);
    expect(isToolAllowed("gunbot_stop_core", perm({ allow: ["gunbot_stop_core"], deny: ["gunbot_stop_core"] }))).toBe(false);
  });

  it("allow can add a single tool to a lower profile", () => {
    expect(isToolAllowed("gunbot_stop_core", perm({ allow: ["gunbot_stop_core"] }))).toBe(true);
    expect(isToolAllowed("gunbot_start_core", perm({ allow: ["gunbot_stop_core"] }))).toBe(false);
  });

  it("unknown tools are never allowed", () => {
    expect(isToolAllowed("gunbot_license_keys_edit", perm({ profile: "full" }))).toBe(false);
  });
});

// Fake server that records registrations, so we test what a model would actually see.
function registered(profile: Permission["profile"] | Permission["profile"][]) {
  const names: string[] = [];
  const host = { registerTool: (name: string) => void names.push(name) } as any;
  const profiles = Array.isArray(profile) ? profile : [profile];
  const instances = new Map<string, Instance>(
    profiles.map((p, i) => [`i${i}`, { name: `i${i}`, perm: perm({ profile: p }), cfg: { url: "http://x" }, client: {} } as unknown as Instance]),
  );
  const ctx: Ctx = { instances, pending: new PendingStore(), dataDir: "/nonexistent", audit: false };
  registerReadTools(host, ctx);
  registerWriteTools(host, ctx);
  return names;
}

describe("tool registration", () => {
  it("registers exactly the tools the profile allows (no drift)", () => {
    for (const p of PROFILES) expect(registered(p).sort()).toEqual(allowedTools(perm({ profile: p })).sort());
  });

  it("every policy entry has an implementation at full profile, and vice versa", () => {
    // flags-gated tools (strategy writes, trading) are not implemented yet and so not in the table.
    expect(registered("full").sort()).toEqual(Object.keys(TOOL_POLICY).sort());
  });

  it("with mixed instances, a tool is visible if ANY instance allows it", () => {
    expect(registered(["read-only", "operator"])).toContain("gunbot_stop_core");
    expect(registered(["read-only", "read-only"])).not.toContain("gunbot_stop_core");
  });

  it("no tool for the blocked license-key endpoint exists in any profile", () => {
    expect(registered("full").filter((n) => /licen[cs]e|key/i.test(n))).toEqual([]);
  });

  it("schema sanity: zod is importable", () => {
    expect(z.string().parse("ok")).toBe("ok");
  });
});
