import { createCipheriv } from "node:crypto";
import { BLOCKED_PATHS } from "./permissions.js";

export interface ClientOptions {
  url: string;
  password: string;
  walletKey: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Login password encryption as documented by Gunbot: AES-128-CBC, key = IV = first 16 bytes of gunthy_wallet. */
export function encryptPassword(password: string, walletKey: string): string {
  const key = Buffer.from(walletKey).subarray(0, 16);
  if (key.length < 16) throw new Error("walletKey must be at least 16 bytes");
  const cipher = createCipheriv("aes-128-cbc", key, key);
  return "ENC:" + Buffer.concat([cipher.update(password, "utf8"), cipher.final()]).toString("base64");
}

export class GunbotApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown> | unknown[];

export class GunbotClient {
  private token?: string;
  private base: string;
  private f: typeof fetch;

  constructor(private opts: ClientOptions) {
    this.base = opts.url.replace(/\/+$/, "") + "/api/v1";
    this.f = opts.fetchImpl ?? fetch;
  }

  private async login(): Promise<void> {
    const res = await this.raw("POST", "/auth/login", { password: encryptPassword(this.opts.password, this.opts.walletKey) });
    const token = (res as { token?: string }).token;
    if (!token) throw new GunbotApiError("Login succeeded but no token was returned");
    this.token = token;
  }

  private async raw(method: string, path: string, body?: unknown, query?: Record<string, string>, auth = false): Promise<unknown> {
    if (BLOCKED_PATHS.some((p) => path.startsWith(p))) throw new GunbotApiError(`Endpoint ${path} is blocked by this server`);
    const qs = query ? "?" + new URLSearchParams(query).toString() : "";
    const res = await this.f(this.base + path + qs, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth && this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) throw new GunbotApiError(`Gunbot API ${method} ${path} failed with HTTP ${res.status}`, res.status);
    return parsed;
  }

  /** Authenticated request; logs in lazily and retries once on 401 (expired token). */
  async request(method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string>): Promise<any> {
    if (!this.token) await this.login();
    try {
      return await this.raw(method, path, body, query, true);
    } catch (e) {
      if (e instanceof GunbotApiError && e.status === 401) {
        await this.login();
        return await this.raw(method, path, body, query, true);
      }
      throw e;
    }
  }

  // --- read ---
  authStatus = () => this.request("GET", "/auth/status");
  time = () => this.request("GET", "/time");
  balances = () => this.request("POST", "/balances", {});
  pairs = (exchange: string) => this.request("GET", "/pairs", undefined, { exchange });
  pnlSum = () => this.request("GET", "/pnl/sum");
  candles = (key: string) => this.request("GET", "/market/candles", undefined, { key });
  orderbook = (key: string) => this.request("GET", "/market/orderbook", undefined, { key });
  corememSingle = (exchange: string, pair: string) => this.request("POST", "/coremem/single", { exchange, pair });
  listStateFiles = () => this.request("GET", "/files/state");
  getStateFile = (filename: string) => this.request("POST", "/files/state/get", { filename });
  listBackups = () => this.request("POST", "/files/backup", {});
  getBackup = (filename: string) => this.request("POST", "/files/backup/get", { filename });

  async getConfig(): Promise<Record<string, any>> {
    const res = await this.request("GET", "/config/full");
    return (res as { config?: Record<string, any> }).config ?? (res as Record<string, any>);
  }

  // --- write (callers must have checked permissions) ---
  updateConfig = (data: Json) => this.request("POST", "/config/update", { data });
  addPair = (exchange: string, pair: string, settings: Json) => this.request("POST", "/config/pair/add", { exchange, pair, settings });
  removePair = (exchange: string, pair: string) => this.request("POST", "/config/pair/remove", { exchange, pair });
  startCore = () => this.request("POST", "/system/start", {});
  stopCore = () => this.request("POST", "/system/stop", {});
}
