/**
 * Permission model. One central table decides which tier each tool needs.
 * Tests assert every registered tool appears here, so a new tool cannot
 * ship without an explicit tier.
 */
export const PROFILES = ["read-only", "config", "operator", "full"] as const;
export type Profile = (typeof PROFILES)[number];

/** Capabilities that need an explicit opt-in even inside the `full` profile. */
export type Flag = "strategyWrites" | "trading";

export interface ToolPolicy {
  tier: Profile;
  flag?: Flag;
}

export const TOOL_POLICY = {
  // read-only
  gunbot_list_instances: { tier: "read-only" },
  gunbot_status: { tier: "read-only" },
  gunbot_get_balances: { tier: "read-only" },
  gunbot_list_pairs: { tier: "read-only" },
  gunbot_get_config: { tier: "read-only" },
  gunbot_get_pair_config: { tier: "read-only" },
  gunbot_get_pair_state: { tier: "read-only" },
  gunbot_get_candles: { tier: "read-only" },
  gunbot_get_orderbook: { tier: "read-only" },
  gunbot_get_pnl_summary: { tier: "read-only" },
  gunbot_list_state_files: { tier: "read-only" },
  gunbot_get_state_file: { tier: "read-only" },
  gunbot_list_backups: { tier: "read-only" },
  gunbot_get_backup: { tier: "read-only" },
  // config: two-step (propose, then apply) with backup and conflict check
  gunbot_propose_pair_change: { tier: "config" },
  gunbot_propose_add_pair: { tier: "config" },
  gunbot_propose_remove_pair: { tier: "config" },
  gunbot_apply_change: { tier: "config" },
  // operator
  gunbot_start_core: { tier: "operator" },
  gunbot_stop_core: { tier: "operator" },
  gunbot_restart_core: { tier: "operator" },
} as const satisfies Record<string, ToolPolicy>;

export type ToolName = keyof typeof TOOL_POLICY;

/** Endpoints this server will never call, in any profile. */
export const BLOCKED_PATHS = ["/license/keys/edit"] as const;

export interface Permission {
  profile: Profile;
  allow: string[];
  deny: string[];
  flags: Record<Flag, boolean>;
}

const rank = (p: Profile) => PROFILES.indexOf(p);

export function isToolAllowed(tool: string, perm: Permission): boolean {
  const policy: ToolPolicy | undefined = (TOOL_POLICY as Record<string, ToolPolicy>)[tool];
  if (!policy) return false; // unknown tools are never allowed
  if (perm.deny.includes(tool)) return false; // deny always wins
  if (perm.allow.includes(tool)) return true;
  if (policy.flag && !perm.flags[policy.flag]) return false;
  return rank(perm.profile) >= rank(policy.tier);
}

export function allowedTools(perm: Permission): string[] {
  return Object.keys(TOOL_POLICY).filter((t) => isToolAllowed(t, perm));
}
