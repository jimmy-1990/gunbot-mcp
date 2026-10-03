import { describe, expect, it } from "vitest";
import { REDACTED, hasMaskedSecrets, hasRealSecrets, redact } from "../src/redact.js";

describe("redact", () => {
  it("redacts credential-looking keys at any depth", () => {
    const out = redact({
      bot: { gunthy_wallet: "abcdef0123456789", password: "pw", name: "x" },
      exchanges: { kraken: { key: "K", secret: "S", enabled: true } },
      nested: [{ apiKey: "a", api_key: "b", API_SECRET: "c", token: "t", licenseKey: "l" }],
    });
    expect(JSON.stringify(out)).not.toMatch(/abcdef0123456789|"pw"|"K"|"S"|"a"|"b"|"c"|"t"|"l"/);
    expect(out.bot.name).toBe("x");
    expect(out.exchanges.kraken.enabled).toBe(true);
  });

  it("redacts secret-looking values under innocent keys", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig";
    const out = redact({ note: jwt, other: "ENC:abc==", fine: "hello" });
    expect(out.note).toBe(REDACTED);
    expect(out.other).toBe(REDACTED);
    expect(out.fine).toBe("hello");
  });

  it("keeps normal Gunbot parameters", () => {
    const params = { BUY_LEVEL: 1.2, TRADING_LIMIT: 50, PERIOD: 15, KEEP_QUOTE: 0, ADX_ENABLED: false };
    expect(redact({ override: params }).override).toEqual(params);
  });

  it("does not mutate its input", () => {
    const input = { secret: "s" };
    redact(input);
    expect(input.secret).toBe("s");
  });
});

describe("credential presence checks", () => {
  it("detects real, missing and masked credentials", () => {
    expect(hasRealSecrets({ exchanges: { k: { key: "AAA", secret: "BBB" } } })).toBe(true);
    expect(hasRealSecrets({ exchanges: { k: { key: "", secret: "" } } })).toBe(false);
    expect(hasRealSecrets({ pairs: {} })).toBe(false);
    expect(hasMaskedSecrets({ exchanges: { k: { key: "********" } } })).toBe(true);
    expect(hasMaskedSecrets({ exchanges: { k: { key: "[REDACTED]" } } })).toBe(true);
    expect(hasMaskedSecrets({ exchanges: { k: { key: "AAA" } } })).toBe(false);
  });
});
