# Contributing

Thanks for helping. This tool touches trading bots that handle real money, so a few ground rules keep it safe.

1. **Never commit real data.** No passwords, keys, wallet values, hostnames, IPs, or real configs, in code, tests, issues, or PRs. Use dummy values. Test fixtures must be obviously fake.
2. **Every tool needs a tier.** Add it to `TOOL_POLICY` in `src/permissions.ts` at the lowest tier that is safe. Tests assert that registration matches the table.
3. **Everything returned to the model is redacted.** Don't bypass `redact()`.
4. **Writes stay two-step** (propose, then apply) with backup and conflict checks. Don't add direct-write tools.
5. **Add tests.** Redaction, permission, and write-path changes need unit tests.

```bash
npm install
npm run typecheck && npm test
npm run build && node test/smoke.mjs
```

Security issues: see [SECURITY.md](SECURITY.md). Don't open public issues for them.

Because Gunbot behaviour varies by version, reports of real-instance differences (response shapes, parameter names) are especially welcome while the project is in beta.
