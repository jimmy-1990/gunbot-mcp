import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasMaskedSecrets, hasRealSecrets, isSecretKey, redact } from "./redact.js";
import type { GunbotClient } from "./client.js";

export type ParamValue = string | number | boolean;
export interface DiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

export type Op =
  | { kind: "set"; exchange: string; pair: string; params?: Record<string, ParamValue>; enabled?: boolean; strategy?: string }
  | { kind: "add"; exchange: string; pair: string; strategy: string }
  | { kind: "remove"; exchange: string; pair: string };

export interface Pending {
  id: string;
  instance: string;
  op: Op;
  baseHash: string;
  diff: DiffEntry[];
  expiresAt: number;
}

// No dots: diff paths are dot-joined and split again during verification.
const NAME = /^[A-Za-z0-9_-]+$/;
const EXCHANGE = /^[A-Za-z0-9_#-]+$/;
const PARAM = /^[A-Za-z0-9_]+$/;
export const CHANGE_TTL_MS = 10 * 60 * 1000;

export function assertNames(exchange: string, pair: string): void {
  if (!EXCHANGE.test(exchange)) throw new Error(`Invalid exchange name: ${exchange}`);
  if (!NAME.test(pair)) throw new Error(`Invalid pair name: ${pair}`);
}

export function validateParams(params: Record<string, ParamValue>, writable: string[]): void {
  for (const [k, v] of Object.entries(params)) {
    if (!PARAM.test(k)) throw new Error(`Invalid parameter name: ${k}`);
    if (isSecretKey(k)) throw new Error(`Parameter ${k} looks like a credential and can never be written`);
    if (!writable.includes("*") && !writable.includes(k)) {
      throw new Error(`Parameter ${k} is not in this instance's writableParams allowlist`);
    }
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`Parameter ${k} must be a finite number`);
    if (typeof v === "string" && v.length > 128) throw new Error(`Parameter ${k} value is too long`);
  }
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, stable(x)]),
    );
  }
  return v;
}

export function configHash(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(stable(config))).digest("hex");
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Compute the new config and a diff for a "set" operation. Pure. */
export function planSet(config: Record<string, any>, op: Extract<Op, { kind: "set" }>): { next: Record<string, any>; diff: DiffEntry[] } {
  const existing = config.pairs?.[op.exchange]?.[op.pair];
  if (!existing) throw new Error(`Pair ${op.exchange}/${op.pair} does not exist in the config`);
  const next = clone(config);
  const target = next.pairs[op.exchange][op.pair];
  const diff: DiffEntry[] = [];
  const base = `pairs.${op.exchange}.${op.pair}`;
  if (op.enabled !== undefined && target.enabled !== op.enabled) {
    diff.push({ path: `${base}.enabled`, before: target.enabled, after: op.enabled });
    target.enabled = op.enabled;
  }
  if (op.strategy !== undefined && target.strategy !== op.strategy) {
    diff.push({ path: `${base}.strategy`, before: target.strategy, after: op.strategy });
    target.strategy = op.strategy;
  }
  for (const [k, v] of Object.entries(op.params ?? {})) {
    target.override ??= {};
    if (target.override[k] !== v) {
      diff.push({ path: `${base}.override.${k}`, before: target.override[k], after: v });
      target.override[k] = v;
    }
  }
  if (diff.length === 0) throw new Error("No changes: every requested value already matches the current config");
  return { next, diff };
}

export function planAdd(config: Record<string, any>, op: Extract<Op, { kind: "add" }>): DiffEntry[] {
  if (config.pairs?.[op.exchange]?.[op.pair]) throw new Error(`Pair ${op.exchange}/${op.pair} already exists`);
  // New pairs are created disabled so nothing trades until a human enables them.
  return [{ path: `pairs.${op.exchange}.${op.pair}`, before: undefined, after: { strategy: op.strategy, enabled: false, override: {} } }];
}

export function planRemove(config: Record<string, any>, op: Extract<Op, { kind: "remove" }>): DiffEntry[] {
  const existing = config.pairs?.[op.exchange]?.[op.pair];
  if (!existing) throw new Error(`Pair ${op.exchange}/${op.pair} does not exist in the config`);
  return [{ path: `pairs.${op.exchange}.${op.pair}`, before: redact(existing), after: undefined }];
}

export function plan(config: Record<string, any>, op: Op): DiffEntry[] {
  if (op.kind === "set") return planSet(config, op).diff;
  if (op.kind === "add") return planAdd(config, op);
  return planRemove(config, op);
}

export class PendingStore {
  private items = new Map<string, Pending>();

  create(instance: string, op: Op, baseHash: string, diff: DiffEntry[]): Pending {
    this.sweep();
    const p: Pending = { id: randomUUID(), instance, op, baseHash, diff, expiresAt: Date.now() + CHANGE_TTL_MS };
    this.items.set(p.id, p);
    return p;
  }

  /** Single use: a change can be applied once. */
  take(id: string): Pending {
    this.sweep();
    const p = this.items.get(id);
    if (!p) throw new Error("Unknown or expired changeId. Propose the change again.");
    this.items.delete(id);
    return p;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, p] of this.items) if (p.expiresAt < now) this.items.delete(id);
  }
}

export function writeBackup(dataDir: string, instance: string, config: unknown): string {
  const dir = join(dataDir, "backups", instance);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export interface ApplyOptions {
  client: GunbotClient;
  dataDir: string;
  allowStrippedConfigWrites: boolean;
}

export async function applyPending(p: Pending, { client, dataDir, allowStrippedConfigWrites }: ApplyOptions) {
  if (p.expiresAt < Date.now()) throw new Error("Change expired. Propose it again.");
  const current = await client.getConfig();

  // 1. Conflict check: the config must be exactly what the proposal was based on.
  if (configHash(current) !== p.baseHash) {
    throw new Error("The Gunbot config changed since this change was proposed. Nothing was written. Propose it again.");
  }

  // 2. Whole-config writes must never round-trip a stripped or masked config.
  if (p.op.kind === "set" && !allowStrippedConfigWrites) {
    if (hasMaskedSecrets(current) || !hasRealSecrets(current)) {
      throw new Error(
        "Refusing to write: the config returned by the API has no real credentials in it (stripped or masked). " +
          "Writing it back could erase your exchange keys. If your setup legitimately has none, set allowStrippedConfigWrites for this instance.",
      );
    }
  }

  // 3. Backup the raw config (contains secrets: 0600 file in a 0700 dir).
  const backupFile = writeBackup(dataDir, p.instance, current);

  // 4. Apply.
  if (p.op.kind === "set") await client.updateConfig(planSet(current, p.op).next);
  else if (p.op.kind === "add") await client.addPair(p.op.exchange, p.op.pair, { strategy: p.op.strategy, enabled: false, override: {} });
  else await client.removePair(p.op.exchange, p.op.pair);

  // 5. Verify by reading back.
  const after = await client.getConfig();
  const verified = p.diff.every((d) => {
    const got = d.path.split(".").reduce<any>((o, k) => o?.[k], after);
    return p.op.kind === "remove" ? got === undefined : JSON.stringify(got) === JSON.stringify(d.after);
  });
  return { backupFile, verified };
}
