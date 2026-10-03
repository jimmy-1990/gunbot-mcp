import { z } from "zod";
import { allowedTools } from "../permissions.js";
import { assertNames } from "../changes.js";
import { defineTool, type Ctx, type ToolHost } from "../registry.js";

const exchange = z.string().describe('Exchange key as used in Gunbot, e.g. "binance" or "binance#3"');
const pair = z.string().describe('Pair as used in Gunbot, e.g. "USDT-BTC"');
const filename = z.string().regex(/^[\w.#-]+$/, "plain filename only").refine((f) => !f.includes(".."), "no path traversal");

const tail = (v: unknown, n: number) => (Array.isArray(v) ? v.slice(-n) : v);

export function registerReadTools(server: ToolHost, ctx: Ctx): void {
  defineTool(server, ctx, {
    name: "gunbot_list_instances",
    description: "List configured Gunbot instances with their permission profile and the tools available on each. Credentials are never shown.",
    shape: {},
    perInstance: false,
    handler: async () =>
      [...ctx.instances.values()].map((i) => ({
        name: i.name,
        url: i.cfg.url,
        profile: i.perm.profile,
        flags: i.perm.flags,
        tools: allowedTools(i.perm),
        writableParams: i.perm.profile === "read-only" ? [] : i.writableParams,
      })),
  });

  defineTool(server, ctx, {
    name: "gunbot_status",
    description: "Check that the Gunbot API is reachable and the login works. Returns auth status and server time.",
    shape: {},
    handler: async (_a, inst) => {
      const [auth, time] = await Promise.allSettled([inst.client.authStatus(), inst.client.time()]);
      return {
        instance: inst.name,
        auth: auth.status === "fulfilled" ? auth.value : `error: ${(auth.reason as Error).message}`,
        time: time.status === "fulfilled" ? time.value : `error: ${(time.reason as Error).message}`,
      };
    },
  });

  defineTool(server, ctx, {
    name: "gunbot_get_balances",
    description: "Get balances across exchanges. Optionally filter by exchange and hide zero balances.",
    shape: { exchange: z.string().optional(), hideZero: z.boolean().default(true) },
    handler: async (a, inst) => {
      const rows: any[] = await inst.client.balances();
      return rows
        .filter((r) => !a.exchange || r.Exchange === a.exchange)
        .filter((r) => !a.hideZero || Number(r["Available Qty"]) > 0 || Number(r["On Order"]) > 0);
    },
  });

  defineTool(server, ctx, {
    name: "gunbot_list_pairs",
    description: "List tradable pairs on an exchange.",
    shape: { exchange },
    handler: async (a, inst) => inst.client.pairs(a.exchange),
  });

  defineTool(server, ctx, {
    name: "gunbot_get_config",
    description:
      "Get the Gunbot config with all credentials redacted. Pass exchange (and optionally pair) to narrow it; the full config can be large.",
    shape: { exchange: exchange.optional(), pair: pair.optional() },
    handler: async (a, inst) => {
      const cfg = await inst.client.getConfig();
      if (a.exchange && a.pair) return cfg.pairs?.[a.exchange]?.[a.pair] ?? `No pair ${a.exchange}/${a.pair} in config`;
      if (a.exchange) return cfg.pairs?.[a.exchange] ?? `No exchange ${a.exchange} in config pairs`;
      return cfg;
    },
  });

  defineTool(server, ctx, {
    name: "gunbot_get_pair_config",
    description: "Get one pair's configuration: strategy, enabled flag, and parameter overrides.",
    shape: { exchange, pair },
    handler: async (a, inst) => {
      assertNames(a.exchange, a.pair);
      const cfg = await inst.client.getConfig();
      return cfg.pairs?.[a.exchange]?.[a.pair] ?? `No pair ${a.exchange}/${a.pair} in config`;
    },
  });

  defineTool(server, ctx, {
    name: "gunbot_get_pair_state",
    description: "Get the live core-memory snapshot for one pair (current trading state, indicators, open orders).",
    shape: { exchange, pair },
    handler: async (a, inst) => {
      assertNames(a.exchange, a.pair);
      return inst.client.corememSingle(a.exchange, a.pair);
    },
  });

  defineTool(server, ctx, {
    name: "gunbot_get_candles",
    description: "Get recent OHLCV candles for a pair (last `limit` entries per series).",
    shape: { exchange, pair, limit: z.number().int().min(1).max(500).default(100) },
    handler: async (a, inst) => {
      assertNames(a.exchange, a.pair);
      const res = await inst.client.candles(`${a.exchange}/${a.pair}`);
      const data = res?.data ?? res;
      return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, tail(v, a.limit)]));
    },
  });

  defineTool(server, ctx, {
    name: "gunbot_get_orderbook",
    description: "Get the current order book for a pair (top `depth` levels each side).",
    shape: { exchange, pair, depth: z.number().int().min(1).max(100).default(20) },
    handler: async (a, inst) => {
      assertNames(a.exchange, a.pair);
      const res = await inst.client.orderbook(`${a.exchange}/${a.pair}`);
      const data = res?.data ?? res;
      return { ask: (data.ask ?? []).slice(0, a.depth), bid: (data.bid ?? []).slice(0, a.depth) };
    },
  });

  defineTool(server, ctx, {
    name: "gunbot_get_pnl_summary",
    description: "Get total profit and loss per exchange.",
    shape: {},
    handler: async (_a, inst) => inst.client.pnlSum(),
  });

  defineTool(server, ctx, {
    name: "gunbot_list_state_files",
    description: "List per-pair state files (these hold order history).",
    shape: {},
    handler: async (_a, inst) => inst.client.listStateFiles(),
  });

  defineTool(server, ctx, {
    name: "gunbot_get_state_file",
    description: "Read a pair's state file, e.g. binance-USDT-XRP-state.json. Returns the most recent `limit` orders.",
    shape: { filename, limit: z.number().int().min(1).max(500).default(50) },
    handler: async (a, inst) => {
      const res = await inst.client.getStateFile(a.filename);
      return { ...res, orders: tail(res?.orders, a.limit) };
    },
  });

  defineTool(server, ctx, {
    name: "gunbot_list_backups",
    description: "List Gunbot's own autoconfig backup files.",
    shape: {},
    handler: async (_a, inst) => inst.client.listBackups(),
  });

  defineTool(server, ctx, {
    name: "gunbot_get_backup",
    description: "Read one of Gunbot's autoconfig backup files (credentials redacted).",
    shape: { filename },
    handler: async (a, inst) => inst.client.getBackup(a.filename),
  });
}
