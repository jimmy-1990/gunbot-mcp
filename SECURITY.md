# Security Policy

`gunbot-mcp` sits between an AI assistant and a trading bot that controls real funds, so security reports are taken seriously.

## Supported versions

This project is in **beta**. Only the latest release on `main` receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private reporting: <https://github.com/jimmy-1990/gunbot-mcp/security/advisories/new>

Include what you can: affected version, steps to reproduce, and the impact. **Never include real passwords, wallet keys, API keys, or unredacted Gunbot configs in a report.** Redact them or use dummy values.

This is a volunteer-run project. I aim to acknowledge reports within 7 days and to ship a fix or mitigation as soon as is practical, but I can't promise a timeline or offer a bounty. I'll credit reporters in the advisory unless you prefer otherwise.

## What counts as a vulnerability here

In scope:
- **Credential exposure:** any way for passwords, wallet keys, exchange API keys, license keys, or tokens to reach the model, logs, error messages, or the audit log.
- **Permission bypass:** a tool running, or being registered, when the configured profile or `deny` list should prevent it.
- **Reaching blocked endpoints:** any path to the license-key edit endpoint, or to manual trading or strategy-file writes without their explicit flags.
- **Unsafe writes:** applying a change that wasn't proposed, applying across instances, skipping the conflict check or backup, or writing back a stripped config that erases credentials.
- **Path traversal or injection** via tool arguments (filenames, pair names, parameter names).
- Insecure file permissions on backups or the audit log.

Out of scope:
- Vulnerabilities in **Gunbot itself** (report those to Gunthy / Gunbot).
- Anyone who already holds your Gunbot password can bypass these profiles. This server limits what an AI assistant can do, it is not access control (see the README's security model).
- Prompt injection by itself. It is a known risk, so keep the profile as low as your task needs. A way to defeat a documented control *through* prompt injection is in scope.
- Findings that require an attacker to already control your machine or MCP client config.

## Safe use

See the **Security model** section of the README. In short: start on `read-only`, use env vars for secrets, keep Gunbot off the open internet, and treat `dataDir` (backups, audit log) as sensitive.
