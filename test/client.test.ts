import { createDecipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GunbotClient, encryptPassword } from "../src/client.js";

const wallet = "0123456789abcdefEXTRA";

describe("encryptPassword", () => {
  it("matches Gunbot's documented scheme (AES-128-CBC, key = iv = first 16 bytes, ENC: + base64)", () => {
    const enc = encryptPassword("hunter2", wallet);
    expect(enc.startsWith("ENC:")).toBe(true);
    const key = Buffer.from(wallet).subarray(0, 16);
    const d = createDecipheriv("aes-128-cbc", key, key);
    const plain = Buffer.concat([d.update(Buffer.from(enc.slice(4), "base64")), d.final()]).toString();
    expect(plain).toBe("hunter2");
  });
  it("rejects short keys", () => expect(() => encryptPassword("x", "short")).toThrow());
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("GunbotClient", () => {
  const mk = (fetchImpl: any) => new GunbotClient({ url: "http://gb:3001/", password: "pw", walletKey: wallet, timeoutMs: 1000, fetchImpl });

  it("logs in lazily and sends the bearer token", async () => {
    const f = vi.fn(async (url: string) => (url.endsWith("/auth/login") ? json({ token: "T1" }) : json({ serverTime: 1 })));
    await mk(f).time();
    expect(f.mock.calls[0][0]).toBe("http://gb:3001/api/v1/auth/login");
    expect((f.mock.calls[1][1] as any).headers.Authorization).toBe("Bearer T1");
  });

  it("re-logs in once on 401", async () => {
    let n = 0;
    const f = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/login")) return json({ token: `T${++n}` });
      return n < 2 ? json({}, 401) : json({ ok: true });
    });
    await expect(mk(f).time()).resolves.toEqual({ ok: true });
    expect(n).toBe(2);
  });

  it("never calls the license-key endpoint", async () => {
    const f = vi.fn(async () => json({ token: "T" }));
    await expect((mk(f) as any).request("POST", "/license/keys/edit", {})).rejects.toThrow(/blocked/);
    expect(f.mock.calls.every(([u]: any) => !String(u).includes("license"))).toBe(true);
  });

  it("error messages never include the response body", async () => {
    const f = vi.fn(async (url: string) => (url.endsWith("/auth/login") ? json({ token: "T" }) : json({ secret: "LEAKME" }, 500)));
    await expect(mk(f).time()).rejects.toThrow(/HTTP 500$/);
  });
});
