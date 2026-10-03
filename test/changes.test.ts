import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PendingStore, applyPending, configHash, plan, planSet, validateParams, writeBackup } from "../src/changes.js";

const base = () => ({
  bot: { gunthy_wallet: "w".repeat(20) },
  exchanges: { binance: { key: "REALKEY", secret: "REALSECRET" } },
  pairs: { binance: { "USDT-XRP": { strategy: "gain", enabled: true, override: { BUY_LEVEL: 1, PERIOD: 15 } } } },
});

describe("validateParams", () => {
  const writable = ["BUY_LEVEL", "PERIOD"];
  it("accepts allowlisted params", () => expect(() => validateParams({ BUY_LEVEL: 2 }, writable)).not.toThrow());
  it("rejects params outside the allowlist", () => expect(() => validateParams({ STOP_LIMIT: 2 }, writable)).toThrow(/allowlist/));
  it("wildcard allows any non-secret param", () => expect(() => validateParams({ ANYTHING: 1 }, ["*"])).not.toThrow());
  it("never allows credential-looking params, even with wildcard", () => {
    expect(() => validateParams({ API_KEY: "x" }, ["*"])).toThrow(/credential/);
    expect(() => validateParams({ secret: "x" }, ["*"])).toThrow(/credential/);
  });
  it("rejects odd names and non-finite numbers", () => {
    expect(() => validateParams({ "a.b": 1 }, ["*"])).toThrow();
    expect(() => validateParams({ BUY_LEVEL: Infinity }, writable)).toThrow(/finite/);
  });
});

describe("planning", () => {
  it("diffs only what changes and leaves the input untouched", () => {
    const cfg = base();
    const { next, diff } = planSet(cfg, { kind: "set", exchange: "binance", pair: "USDT-XRP", params: { BUY_LEVEL: 2, PERIOD: 15 } });
    expect(diff).toEqual([{ path: "pairs.binance.USDT-XRP.override.BUY_LEVEL", before: 1, after: 2 }]);
    expect(next.pairs.binance["USDT-XRP"].override.BUY_LEVEL).toBe(2);
    expect(cfg.pairs.binance["USDT-XRP"].override.BUY_LEVEL).toBe(1);
  });
  it("rejects no-op and unknown pairs", () => {
    expect(() => planSet(base(), { kind: "set", exchange: "binance", pair: "USDT-XRP", params: { BUY_LEVEL: 1 } })).toThrow(/No changes/);
    expect(() => planSet(base(), { kind: "set", exchange: "binance", pair: "NOPE", enabled: false })).toThrow(/does not exist/);
  });
  it("adds new pairs disabled, and refuses duplicates", () => {
    const [d] = plan(base(), { kind: "add", exchange: "binance", pair: "USDT-ADA", strategy: "gain" });
    expect((d.after as any).enabled).toBe(false);
    expect(() => plan(base(), { kind: "add", exchange: "binance", pair: "USDT-XRP", strategy: "gain" })).toThrow(/already exists/);
  });
  it("hash is order-independent", () => {
    expect(configHash({ a: 1, b: { c: 2, d: 3 } })).toBe(configHash({ b: { d: 3, c: 2 }, a: 1 }));
  });
});

describe("PendingStore", () => {
  it("changes are single use and expire", () => {
    const s = new PendingStore();
    const p = s.create("i", { kind: "remove", exchange: "e", pair: "p" }, "h", []);
    expect(s.take(p.id).id).toBe(p.id);
    expect(() => s.take(p.id)).toThrow(/Unknown or expired/);
    vi.useFakeTimers();
    const q = s.create("i", { kind: "remove", exchange: "e", pair: "p" }, "h", []);
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(() => s.take(q.id)).toThrow(/Unknown or expired/);
    vi.useRealTimers();
  });
});

function fakeClient(initial: any) {
  let cfg = structuredClone(initial);
  return {
    getConfig: vi.fn(async () => structuredClone(cfg)),
    updateConfig: vi.fn(async (next: any) => void (cfg = structuredClone(next))),
    addPair: vi.fn(),
    removePair: vi.fn(),
    mutateExternally: (fn: (c: any) => void) => fn(cfg),
  };
}

describe("applyPending", () => {
  const op = { kind: "set", exchange: "binance", pair: "USDT-XRP", params: { BUY_LEVEL: 3 } } as const;
  const mk = (cfg: any) => {
    const dataDir = mkdtempSync(join(tmpdir(), "gbmcp-"));
    const client = fakeClient(cfg);
    const store = new PendingStore();
    const p = store.create("main", op, configHash(cfg), plan(cfg, op));
    return { dataDir, client, p };
  };

  it("backs up, writes, and verifies; backup is private and holds the raw config", async () => {
    const { dataDir, client, p } = mk(base());
    const r = await applyPending(p, { client: client as any, dataDir, allowStrippedConfigWrites: false });
    expect(r.verified).toBe(true);
    expect(client.updateConfig).toHaveBeenCalledOnce();
    expect((await client.getConfig()).pairs.binance["USDT-XRP"].override.BUY_LEVEL).toBe(3);
    expect(statSync(r.backupFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(r.backupFile, "utf8")).exchanges.binance.key).toBe("REALKEY");
    // the credentials survive the round trip
    expect((await client.getConfig()).exchanges.binance.key).toBe("REALKEY");
  });

  it("refuses when the config changed after the proposal, and writes nothing", async () => {
    const { dataDir, client, p } = mk(base());
    client.mutateExternally((c) => (c.pairs.binance["USDT-XRP"].enabled = false));
    await expect(applyPending(p, { client: client as any, dataDir, allowStrippedConfigWrites: false })).rejects.toThrow(/changed since/);
    expect(client.updateConfig).not.toHaveBeenCalled();
  });

  it("refuses to write back a config that has no real credentials", async () => {
    const stripped = base();
    delete (stripped as any).exchanges;
    delete (stripped as any).bot;
    const { dataDir, client, p } = mk(stripped);
    await expect(applyPending(p, { client: client as any, dataDir, allowStrippedConfigWrites: false })).rejects.toThrow(/no real credentials/);
    expect(client.updateConfig).not.toHaveBeenCalled();
  });

  it("refuses masked credentials, but the explicit override lets it through", async () => {
    const masked = base();
    masked.exchanges.binance.key = "********";
    const a = mk(masked);
    await expect(applyPending(a.p, { client: a.client as any, dataDir: a.dataDir, allowStrippedConfigWrites: false })).rejects.toThrow();
    const b = mk(masked);
    await expect(applyPending(b.p, { client: b.client as any, dataDir: b.dataDir, allowStrippedConfigWrites: true })).resolves.toBeTruthy();
  });

  it("writeBackup creates files only owner can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "gbmcp-"));
    expect(statSync(writeBackup(dir, "x", { a: 1 })).mode & 0o077).toBe(0);
  });
});
