// End-to-end smoke test: real MCP client <-> built server over stdio <-> mock Gunbot HTTP API.
// Run with: npm run build && node test/smoke.mjs
import http from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const config = { bot: { gunthy_wallet: "0123456789abcdefXX" }, exchanges: { binance: { key: "REALKEY", secret: "REALSECRET" } },
  pairs: { binance: { "USDT-XRP": { strategy: "gain", enabled: true, override: { BUY_LEVEL: 1 } } } } };
const hits = [];
const srv = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c));
  req.on("end", () => {
    hits.push(`${req.method} ${req.url}`);
    const send = (o, s = 200) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url === "/api/v1/auth/login") return send({ status: "success", token: "tok" });
    if (req.headers.authorization !== "Bearer tok") return send({}, 401);
    if (req.url === "/api/v1/config/full") return send({ status: "success", config });
    if (req.url === "/api/v1/config/update") { Object.assign(config, JSON.parse(body).data); return send({ status: "success" }); }
    if (req.url === "/api/v1/time") return send({ serverTime: 1 });
    send({}, 404);
  });
});
await new Promise((r) => srv.listen(0, r));
const url = `http://127.0.0.1:${srv.address().port}`;
const dir = mkdtempSync(join(tmpdir(), "gbsmoke-"));

async function session(profile) {
  const cfgPath = join(dir, `${profile}.json`);
  writeFileSync(cfgPath, JSON.stringify({ profile, dataDir: join(dir, "data"), instances: { main: { url, passwordEnv: "PW", walletKeyEnv: "WK" } } }));
  const c = new Client({ name: "smoke", version: "0" });
  await c.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: { ...process.env, GUNBOT_MCP_CONFIG: cfgPath, PW: "pw", WK: "0123456789abcdefXX" }, stderr: "ignore" }));
  return c;
}
const text = (r) => r.content[0].text;
let failed = 0;
const check = (name, ok) => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failed++; };

const ro = await session("read-only");
const roTools = (await ro.listTools()).tools.map((t) => t.name);
check("read-only exposes no write tools", !roTools.some((n) => /propose|apply|start|stop|restart/.test(n)));
const cfgOut = text(await ro.callTool({ name: "gunbot_get_config", arguments: {} }));
check("get_config redacts credentials", !/REALKEY|REALSECRET|0123456789abcdefXX/.test(cfgOut) && cfgOut.includes("[REDACTED]"));
check("status works through login", text(await ro.callTool({ name: "gunbot_status", arguments: {} })).includes("serverTime"));
await ro.close();

const cf = await session("config");
const cfTools = (await cf.listTools()).tools.map((t) => t.name);
check("config profile has propose/apply but no start/stop", cfTools.includes("gunbot_apply_change") && !cfTools.includes("gunbot_stop_core"));
const prop = JSON.parse(text(await cf.callTool({ name: "gunbot_propose_pair_change", arguments: { exchange: "binance", pair: "USDT-XRP", params: { BUY_LEVEL: 2 } } })));
check("propose writes nothing", !hits.includes("POST /api/v1/config/update") && prop.diff.length === 1);
const bad = await cf.callTool({ name: "gunbot_propose_pair_change", arguments: { exchange: "binance", pair: "USDT-XRP", params: { API_KEY: "x" } } });
check("credential-like param rejected", bad.isError === true);
const applied = JSON.parse(text(await cf.callTool({ name: "gunbot_apply_change", arguments: { changeId: prop.changeId, confirm: true } })));
check("apply writes, verifies, and keeps credentials", applied.verified === true && config.exchanges.binance.key === "REALKEY" && config.pairs.binance["USDT-XRP"].override.BUY_LEVEL === 2);
const replay = await cf.callTool({ name: "gunbot_apply_change", arguments: { changeId: prop.changeId, confirm: true } });
check("changeId is single-use", replay.isError === true);
await cf.close();

srv.close();
console.log(failed ? `\n${failed} FAILED` : "\nall smoke checks passed");
process.exit(failed ? 1 : 0);
