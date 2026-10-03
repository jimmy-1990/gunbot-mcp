import { z } from "zod";
import {
  CHANGE_TTL_MS,
  applyPending,
  assertNames,
  configHash,
  plan,
  validateParams,
  type Op,
} from "../changes.js";
import { defineTool, type Ctx, type Instance, type ToolHost } from "../registry.js";

const exchange = z.string().describe('Exchange key as used in Gunbot, e.g. "binance" or "binance#3"');
const pair = z.string().describe('Pair as used in Gunbot, e.g. "USDT-BTC"');
const confirm = z.literal(true).describe("Must be true. Confirms the caller intends this action.");

async function propose(ctx: Ctx, inst: Instance, op: Op) {
  assertNames(op.exchange, op.pair);
  const config = await inst.client.getConfig();
  const diff = plan(config, op);
  const p = ctx.pending.create(inst.name, op, configHash(config), diff);
  return {
    changeId: p.id,
    instance: inst.name,
    expiresInSeconds: CHANGE_TTL_MS / 1000,
    diff,
    next: "Nothing has been written. Review the diff with the user, then call gunbot_apply_change with this changeId.",
  };
}

export function registerWriteTools(server: ToolHost, ctx: Ctx): void {
  defineTool(server, ctx, {
    name: "gunbot_propose_pair_change",
    description:
      "Propose changes to an existing pair: parameter overrides, enabled flag, or strategy. Returns a diff and a changeId. Does NOT write anything.",
    shape: {
      exchange,
      pair,
      params: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Override parameters to set, e.g. {\"BUY_LEVEL\": 0.8}"),
      enabled: z.boolean().optional(),
      strategy: z.string().regex(/^[\w-]+$/).optional(),
    },
    handler: async (a, inst) => {
      if (a.params) validateParams(a.params, inst.writableParams);
      if (!a.params && a.enabled === undefined && !a.strategy) throw new Error("Nothing to change: pass params, enabled, or strategy");
      return propose(ctx, inst, { kind: "set", exchange: a.exchange, pair: a.pair, params: a.params, enabled: a.enabled, strategy: a.strategy });
    },
  });

  defineTool(server, ctx, {
    name: "gunbot_propose_add_pair",
    description: "Propose adding a new pair. It is always created DISABLED. Returns a diff and a changeId. Does NOT write anything.",
    shape: { exchange, pair, strategy: z.string().regex(/^[\w-]+$/).describe("Strategy name that already exists in Gunbot") },
    handler: async (a, inst) => propose(ctx, inst, { kind: "add", exchange: a.exchange, pair: a.pair, strategy: a.strategy }),
  });

  defineTool(server, ctx, {
    name: "gunbot_propose_remove_pair",
    description: "Propose removing a pair from the config. Returns a diff and a changeId. Does NOT write anything.",
    shape: { exchange, pair },
    handler: async (a, inst) => propose(ctx, inst, { kind: "remove", exchange: a.exchange, pair: a.pair }),
  });

  defineTool(server, ctx, {
    name: "gunbot_apply_change",
    description:
      "Apply a previously proposed change. Refuses if the config changed since the proposal. Backs up the config first and verifies by reading it back. Single use.",
    shape: { changeId: z.string().uuid(), confirm },
    handler: async (a, inst) => {
      const p = ctx.pending.take(a.changeId);
      if (p.instance !== inst.name) throw new Error(`This change was proposed for instance "${p.instance}", not "${inst.name}"`);
      const { backupFile, verified } = await applyPending(p, {
        client: inst.client,
        dataDir: ctx.dataDir,
        allowStrippedConfigWrites: inst.cfg.allowStrippedConfigWrites,
      });
      return {
        applied: true,
        verified,
        backupFile,
        diff: p.diff,
        note: verified ? undefined : "Read-back did not match exactly (Gunbot may normalise values). Check with gunbot_get_pair_config.",
      };
    },
  });

  // --- operator ---
  defineTool(server, ctx, {
    name: "gunbot_start_core",
    description: "Start the Gunbot trading core. It will begin trading enabled pairs.",
    shape: { confirm },
    handler: async (_a, inst) => {
      await inst.client.startCore();
      return { ok: true, action: "start", instance: inst.name };
    },
  });

  defineTool(server, ctx, {
    name: "gunbot_stop_core",
    description: "Stop the Gunbot trading core. Open orders on the exchange are NOT cancelled.",
    shape: { confirm },
    handler: async (_a, inst) => {
      await inst.client.stopCore();
      return { ok: true, action: "stop", instance: inst.name };
    },
  });

  defineTool(server, ctx, {
    name: "gunbot_restart_core",
    description: "Stop then start the Gunbot trading core.",
    shape: { confirm },
    handler: async (_a, inst) => {
      await inst.client.stopCore();
      await new Promise((r) => setTimeout(r, 3000));
      await inst.client.startCore();
      return { ok: true, action: "restart", instance: inst.name };
    },
  });
}
