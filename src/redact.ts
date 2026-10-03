/**
 * Secret redaction. Applied to EVERY value returned to the model.
 * Deliberately not configurable: there is no switch that turns this off.
 */
export const REDACTED = "[REDACTED]";

// Key names that look like credentials. Matched case-insensitively against object keys.
const SECRET_KEY =
  /secret|passw(or)?d|passphrase|token|wallet|licen[cs]e|private|api[_-]?key|bearer|credential|^keys?$|_keys?$|^key_|^pub(lic)?key$/i;

// Values that look like credentials regardless of the key they sit under.
const SECRET_VALUE = [
  /^ENC:/, // Gunbot-encrypted values
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/, // JWT
];

export function isSecretKey(name: string): boolean {
  return SECRET_KEY.test(name);
}

function isSecretValue(v: string): boolean {
  return SECRET_VALUE.some((re) => re.test(v));
}

const MASKED = /^\*+$|redacted|masked|^x{3,}$/i;

/**
 * Does this config contain real (unmasked, non-empty) credentials?
 * Used before whole-config writes: if the API returned a stripped or masked
 * config, writing it back would wipe the credentials stored in Gunbot.
 */
export function hasRealSecrets(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasRealSecrets);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => {
      if (isSecretKey(k) && typeof v === "string" && v !== "") return !MASKED.test(v);
      return hasRealSecrets(v);
    });
  }
  return false;
}

/** True if any secret-looking field holds a masked placeholder instead of a real value. */
export function hasMaskedSecrets(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasMaskedSecrets);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(([k, v]) => {
      if (isSecretKey(k) && typeof v === "string" && v !== "") return MASKED.test(v);
      return hasMaskedSecrets(v);
    });
  }
  return false;
}

export function redact<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) && v !== null && v !== undefined && v !== "" ? REDACTED : walk(v);
    }
    return out;
  }
  if (typeof value === "string" && isSecretValue(value)) return REDACTED;
  return value;
}
