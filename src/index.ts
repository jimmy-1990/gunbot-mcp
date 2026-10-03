#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, resolveInstances } from "./config.js";
import { GunbotClient } from "./client.js";
import { PendingStore } from "./changes.js";
import { allowedTools } from "./permissions.js";
import type { Ctx, Instance } from "./registry.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

// stdout carries the MCP protocol, so all logging goes to stderr.
const log = (msg: string) => process.stderr.write(`[gunbot-mcp] ${msg}\n`);

async function main() {
  const cfg = loadConfig();
  const instances = new Map<string, Instance>();
  for (const r of resolveInstances(cfg)) {
    const client = new GunbotClient({ url: r.cfg.url, password: r.password, walletKey: r.walletKey, timeoutMs: r.cfg.timeoutMs });
    instances.set(r.name, { ...r, client });
    log(`instance "${r.name}": profile=${r.perm.profile}, ${allowedTools(r.perm).length} tools enabled`);
  }

  const ctx: Ctx = { instances, pending: new PendingStore(), dataDir: cfg.dataDir, audit: cfg.audit };
  const server = new McpServer({ name: "gunbot-mcp", version: "0.1.0" });
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);

  await server.connect(new StdioServerTransport());
  log("ready (stdio)");
}

main().catch((e) => {
  log(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
