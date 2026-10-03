import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GunbotClient } from "./client.js";
import type { ResolvedInstance } from "./config.js";
import type { PendingStore } from "./changes.js";
import { TOOL_POLICY, isToolAllowed, type ToolName } from "./permissions.js";
import { redact } from "./redact.js";

export interface Instance extends ResolvedInstance {
  client: GunbotClient;
}

export interface Ctx {
  instances: Map<string, Instance>;
  pending: PendingStore;
  dataDir: string;
  audit: boolean;
}

export type ToolHost = Pick<McpServer, "registerTool">;

const MAX_OUTPUT_CHARS = 60_000;

export function resolveInstance(ctx: Ctx, name?: string): Instance {
  if (name) {
    const inst = ctx.instances.get(name);
    if (!inst) throw new Error(`Unknown instance "${name}". Known: ${[...ctx.instances.keys()].join(", ")}`);
    return inst;
  }
  if (ctx.instances.size === 1) return [...ctx.instances.values()][0];
  throw new Error(`Multiple instances configured; pass "instance". Known: ${[...ctx.instances.keys()].join(", ")}`);
}

function audit(ctx: Ctx, entry: Record<string, unknown>): void {
  if (!ctx.audit) return;
  try {
    mkdirSync(ctx.dataDir, { recursive: true, mode: 0o700 });
    appendFileSync(join(ctx.dataDir, "audit.log"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
  } catch {
    /* auditing must never break a call */
  }
}

function text(value: unknown, isError = false) {
  let s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (s.length > MAX_OUTPUT_CHARS) s = s.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated ${s.length - MAX_OUTPUT_CHARS} chars]`;
  return { content: [{ type: "text" as const, text: s }], ...(isError ? { isError: true } : {}) };
}

interface DefineOpts<S extends z.ZodRawShape> {
  name: ToolName;
  description: string;
  shape: S;
  /** false: tool spans all instances and takes no `instance` argument. */
  perInstance?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>, inst: Instance) => Promise<unknown>;
}

/**
 * Register a tool only if at least one instance permits it, and re-check the
 * permission against the target instance on every call.
 */
export function defineTool<S extends z.ZodRawShape>(server: ToolHost, ctx: Ctx, o: DefineOpts<S>): boolean {
  const visible = [...ctx.instances.values()].some((i) => isToolAllowed(o.name, i.perm));
  if (!visible) return false;

  const tier = TOOL_POLICY[o.name].tier;
  const perInstance = o.perInstance !== false;
  const shape = perInstance
    ? { instance: z.string().optional().describe("Instance name (optional when only one is configured)"), ...o.shape }
    : o.shape;

  server.registerTool(o.name, { description: o.description, inputSchema: shape }, (async (args: any) => {
    let inst: Instance | undefined;
    try {
      inst = perInstance ? resolveInstance(ctx, args.instance) : [...ctx.instances.values()][0];
      if (perInstance && !isToolAllowed(o.name, inst.perm)) {
        throw new Error(`${o.name} is not permitted on instance "${inst.name}" (profile: ${inst.perm.profile})`);
      }
      const result = redact(await o.handler(args, inst));
      if (tier !== "read-only") audit(ctx, { tool: o.name, instance: inst.name, args: redact(args), ok: true });
      return text(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (tier !== "read-only") audit(ctx, { tool: o.name, instance: inst?.name ?? args?.instance, args: redact(args), ok: false, error: msg });
      return text(`Error: ${msg}`, true);
    }
  }) as any);
  return true;
}
