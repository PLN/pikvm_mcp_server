// Modified 2026-10 by PLN: redact password forms and the configured secret (GPL-3.0; see NOTICE).

/** kvmd error type and error_msg are capped here, about 1 KB each. */
export const KVMD_FIELD_MAX_CHARS = 1024;

/**
 * Strip credential material from a kvmd error string.
 * `secret`, when set, is the configured kvmd password and is removed
 * wherever it appears as a literal.
 */
export function redactSecrets(text: string, secret?: string): string {
  let out = text
    .replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"[REDACTED]"')
    .replace(/password\s*[:=]\s*"[^"]*"/gi, 'password=[REDACTED]')
    .replace(/password\s*[:=]\s*[^\s,"]+/gi, 'password=[REDACTED]')
    .replace(/X-KVMD-Passwd(?:\s*[:=]\s*|\s+)?[^\s,"]*/gi, 'X-KVMD-Passwd=[REDACTED]');
  // A 1–3 character password is a substring of ordinary words ("cat"
  // inside "category"). Only a longer secret is removed literally.
  if (secret && secret.length >= 4) {
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

export function capKvmdField(value: string): string {
  return value.length <= KVMD_FIELD_MAX_CHARS ? value : value.slice(0, KVMD_FIELD_MAX_CHARS);
}
