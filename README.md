# gunbot-mcp

> ## ⚠️ BETA SOFTWARE
> This project is in **beta** (`0.1.0-beta.1`). It has been built from Gunbot's public API docs and tested against a mock server, **not yet across a range of real Gunbot installs**. Expect rough edges, and expect behaviour to change between releases.
>
> - Run it on a **paper-trading or low-stakes instance first**.
> - Keep it on the default **`read-only`** profile until you've seen it work correctly against your own setup.
> - Treat every write (`config` and above) as experimental, and review each diff before applying it.
> - Please [open an issue](../../issues) with anything that behaves differently from what's documented here.

An **unofficial** [Model Context Protocol](https://modelcontextprotocol.io) server for the [Gunbot](https://www.gunbot.com) REST API. It lets an AI assistant check on your bots, review config, and (if you allow it) make controlled changes, with you choosing exactly how much power it gets.

> **Not affiliated with or endorsed by Gunbot / Gunthy.** "Gunbot" is their trademark.
>
> **Trading bots handle real money.** This software is provided as-is, with no warranty, and is not financial advice. A bad setting or a bug can lose funds. Start read-only, test writes against a paper-trading or low-stakes instance first, and read the [Security model](#security-model).

## Permission profiles

You choose a profile per server and/or per instance. The default is `read-only`.

| Profile | Adds |
|---|---|
| `read-only` (default) | Status, balances, pairs, market data, PNL, order history, **redacted** config, backups |
| `config` | Propose and apply pair changes (parameters, enabled, strategy), add/remove pairs |
| `operator` | Start, stop, restart the trading core |
| `full` | Reserved for strategy-file writes and manual trading (not implemented yet; both need an explicit opt-in flag) |

Each profile includes everything below it. Fine-tune with `allow` / `deny` lists of tool names (**deny always wins**).

Tools a profile doesn't permit are **not registered at all**, so the model never sees them. Every call is also re-checked against the target instance.

## Tools

**read-only:** `gunbot_list_instances`, `gunbot_status`, `gunbot_get_balances`, `gunbot_list_pairs`, `gunbot_get_config`, `gunbot_get_pair_config`, `gunbot_get_pair_state`, `gunbot_get_candles`, `gunbot_get_orderbook`, `gunbot_get_pnl_summary`, `gunbot_list_state_files`, `gunbot_get_state_file`, `gunbot_list_backups`, `gunbot_get_backup`

**config:** `gunbot_propose_pair_change`, `gunbot_propose_add_pair`, `gunbot_propose_remove_pair`, `gunbot_apply_change`

**operator:** `gunbot_start_core`, `gunbot_stop_core`, `gunbot_restart_core`

Writes are **two-step**. A `propose_*` call writes nothing and returns a diff plus a single-use `changeId` (valid 10 minutes). `apply_change` then:

1. refuses if the config changed since the proposal,
2. refuses to write back a config that has no real credentials in it (see below),
3. saves a backup of the raw config (mode `0600`),
4. applies the change,
5. reads the config back to verify.

New pairs are always created **disabled**. Only parameters in `writableParams` can be changed, and anything that looks like a credential can never be written.

## Setup

Requires Node 20+ and a Gunbot instance with its GUI/API reachable.

```bash
npm install
npm run build
cp config.example.json gunbot-mcp.config.json   # edit it
```

Secrets are read from environment variables, never from the config file:

- `passwordEnv`: env var holding your Gunbot GUI password.
- `walletKeyEnv`: env var holding `bot.gunthy_wallet` from your Gunbot `config.js`. Gunbot's login encrypts the password with it.

Config is found via `GUNBOT_MCP_CONFIG`, then `./gunbot-mcp.config.json`, then `~/.config/gunbot-mcp/config.json`.

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "gunbot": {
      "command": "node",
      "args": ["/absolute/path/to/gunbot-mcp/dist/index.js"],
      "env": {
        "GUNBOT_MCP_CONFIG": "/absolute/path/to/gunbot-mcp.config.json",
        "GUNBOT_MAIN_PASSWORD": "...",
        "GUNBOT_MAIN_WALLET_KEY": "..."
      }
    }
  }
}
```

## Configuration

```jsonc
{
  "profile": "read-only",          // server-wide default
  "allow": [], "deny": [],          // tool names; deny wins
  "flags": { "strategyWrites": false, "trading": false },
  "writableParams": ["BUY_LEVEL"],  // override params the model may change; ["*"] = any non-credential
  "dataDir": "~/.gunbot-mcp",       // backups + audit log
  "audit": true,                    // JSONL log of every non-read call
  "instances": {
    "main": {
      "url": "http://host:3001",
      "passwordEnv": "...", "walletKeyEnv": "...",
      "profile": "config",          // per-instance override
      "allowStrippedConfigWrites": false,
      "timeoutMs": 15000
    }
  }
}
```

Every tool takes an optional `instance` argument (required only when several are configured).

## Security model

Read this before enabling anything above `read-only`. To report a vulnerability privately, see [SECURITY.md](SECURITY.md).

- **This restricts the MCP server, not your Gunbot password.** Gunbot's API has no scoped tokens: one login can do everything, including manual trades and license-key edits. Anyone who has your password can bypass these profiles. They exist to keep an *AI assistant* on a leash, not to be access control.
- **Credentials never reach the model.** Everything returned is run through a redactor (credential-looking keys at any depth, plus `ENC:` and JWT-shaped values). It is deliberately not configurable. Error messages never include response bodies.
- **Never exposed, in any profile:** license-key editing (the endpoint is hard-blocked in the client). Strategy-file writes and manual buy/sell/cancel are not implemented and will need explicit flags.
- **The password is high-value.** It controls your bot. Keep it in env vars or a secrets manager, and don't commit it.
- **Use HTTPS or a trusted network.** Gunbot defaults to plain HTTP. If the instance isn't on localhost, put it behind TLS or a VPN.
- **Backups contain secrets.** `dataDir/backups/` holds raw config copies (files `0600`, directory `0700`). Treat it like the Gunbot config itself.
- **Whole-config writes.** Gunbot's `config/update` replaces the entire config. If the API ever returns a stripped or masked config, writing it back would erase your exchange keys. So `apply_change` refuses unless the config it read contains real, unmasked credentials. Only set `allowStrippedConfigWrites` if you've verified your setup round-trips safely.
- **Prompt injection.** Anything the model reads (pair names, order data) is untrusted input. Keep the profile as low as your task needs.

## Status

**Beta** (`0.1.0-beta.1`). Built from Gunbot's public API docs and tested against a mock server, not yet against a range of real instances.

- Verified against docs: login encryption, config get/update/pair add/remove, balances, pairs, candles, orderbook, coremem, state files, backups, start/stop.
- **Unverified response shapes:** PNL (`/pnl/sum`), and Gunbot's behaviour when writing back the full config. Please test on a non-production instance and open an issue with what you find.
- Docs disagree on the default port (3000 vs 3001). Set it in `url`.
- Default `writableParams` is a conservative guess at common parameter names. Check them against your Gunbot version.
- No log access yet: Gunbot's API has no log endpoint. An optional SSH/pm2 backend is planned.

## Development

```bash
npm test            # unit tests (redaction, permissions, change-set logic, client)
npm run typecheck
npm run build && node test/smoke.mjs   # end-to-end over stdio against a mock Gunbot
```

## License

MIT
