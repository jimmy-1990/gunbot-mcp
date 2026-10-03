import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PROFILES, TOOL_POLICY, type Permission } from "./permissions.js";

const profileSchema = z.enum(PROFILES);
const toolNames = Object.keys(TOOL_POLICY);
const toolList = z.array(z.string().refine((t) => toolNames.includes(t), { message: "unknown tool name" }));

const flagsSchema = z
  .object({ strategyWrites: z.boolean().default(false), trading: z.boolean().default(false) })
  .default({});

const instanceSchema = z.object({
  /** Base URL of the Gunbot GUI/API, e.g. http://10.0.0.5:3001 (no trailing /api). */
  url: z.string().url(),
  /** Name of the env var holding the Gunbot GUI password. */
  passwordEnv: z.string().min(1),
  /** Name of the env var holding bot.gunthy_wallet from Gunbot's config (used to encrypt the login). */
  walletKeyEnv: z.string().min(1),
  profile: profileSchema.optional(),
  allow: toolList.optional(),
  deny: toolList.optional(),
  flags: z.object({ strategyWrites: z.boolean().optional(), trading: z.boolean().optional() }).optional(),
  /** Pair override parameters the model may change. ["*"] allows any non-secret parameter. */
  writableParams: z.array(z.string()).optional(),
  /** Allow whole-config writes even when the API returns no real credentials. See README before enabling. */
  allowStrippedConfigWrites: z.boolean().default(false),
  timeoutMs: z.number().int().positive().default(15000),
});

const configSchema = z.object({
  profile: profileSchema.default("read-only"),
  allow: toolList.default([]),
  deny: toolList.default([]),
  flags: flagsSchema,
  writableParams: z.array(z.string()).default(DEFAULT_WRITABLE()),
  /** Where backups and the audit log live. */
  dataDir: z.string().default(join(homedir(), ".gunbot-mcp")),
  audit: z.boolean().default(true),
  instances: z.record(instanceSchema).refine((i) => Object.keys(i).length > 0, "at least one instance required"),
});

/** Conservative defaults. Extend in config; verify names against your Gunbot version. */
function DEFAULT_WRITABLE(): string[] {
  return [
    "TRADING_LIMIT",
    "BUY_ENABLED",
    "SELL_ENABLED",
    "BUY_LEVEL",
    "SELL_LEVEL",
    "GAIN",
    "STOP_LIMIT",
    "PERIOD",
    "MAX_BUY_COUNT",
    "MIN_VOLUME_TO_BUY",
    "MIN_VOLUME_TO_SELL",
    "KEEP_QUOTE",
  ];
}

export type GunbotMcpConfig = z.infer<typeof configSchema>;
export type InstanceConfig = z.infer<typeof instanceSchema>;

export interface ResolvedInstance {
  name: string;
  cfg: InstanceConfig;
  perm: Permission;
  writableParams: string[];
  password: string;
  walletKey: string;
}

export function findConfigPath(env = process.env): string {
  const candidates = [
    env.GUNBOT_MCP_CONFIG,
    join(process.cwd(), "gunbot-mcp.config.json"),
    join(homedir(), ".config", "gunbot-mcp", "config.json"),
  ].filter((p): p is string => !!p);
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(
      `No config found. Set GUNBOT_MCP_CONFIG or create one of:\n  ${candidates.join("\n  ")}\nSee config.example.json.`,
    );
  }
  return found;
}

export function parseConfig(raw: unknown): GunbotMcpConfig {
  return configSchema.parse(raw);
}

export function resolveInstances(cfg: GunbotMcpConfig, env = process.env): ResolvedInstance[] {
  return Object.entries(cfg.instances).map(([name, ic]) => {
    const password = env[ic.passwordEnv];
    const walletKey = env[ic.walletKeyEnv];
    if (!password) throw new Error(`Instance "${name}": env var ${ic.passwordEnv} is not set`);
    if (!walletKey) throw new Error(`Instance "${name}": env var ${ic.walletKeyEnv} is not set`);
    const perm: Permission = {
      profile: ic.profile ?? cfg.profile,
      allow: [...cfg.allow, ...(ic.allow ?? [])],
      deny: [...cfg.deny, ...(ic.deny ?? [])],
      flags: {
        strategyWrites: ic.flags?.strategyWrites ?? cfg.flags.strategyWrites,
        trading: ic.flags?.trading ?? cfg.flags.trading,
      },
    };
    return { name, cfg: ic, perm, writableParams: ic.writableParams ?? cfg.writableParams, password, walletKey };
  });
}

export function loadConfig(path = findConfigPath()): GunbotMcpConfig {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}
