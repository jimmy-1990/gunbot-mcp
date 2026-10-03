## What and why

## Checklist
- [ ] `npm run typecheck`, `npm test`, and `npm run build && node test/smoke.mjs` pass
- [ ] New tools have an entry in `TOOL_POLICY` (`src/permissions.ts`) with the lowest tier that is safe, and tests
- [ ] Nothing real in the diff: no passwords, keys, wallet values, hostnames, IPs, or configs (use dummy values)
- [ ] Anything returned to the model goes through redaction
- [ ] README updated if behaviour or the security model changed
