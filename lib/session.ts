/**
 * Signed-session helpers shared by the Edge middleware and the Node auth
 * functions. Web Crypto only (available in both runtimes), no dependencies,
 * and no btoa/atob (kept out of this project's tsconfig lib).
 *
 * Token format: b64url(JSON payload) + "." + b64url(HMAC-SHA256(payload))
 */

export const SESSION_COOKIE = "vi_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export interface SessionPayload {
  sub: string;         // Entra object id
  email: string;       // UPN
  name: string;
  principalId: string; // VistaCRM principals.id
  kind: string;        // partner | staff | service | spoke_app
  canWrite: boolean;
  src: "vistacrm" | "fallback";
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function b64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    if (has1) out += B64[((b1 & 15) << 2) | (b2 >> 6)];
    if (has2) out += B64[b2 & 63];
  }
  return out;
}

function b64urlDecode(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const c0 = B64.indexOf(s[i]);
    const c1 = i + 1 < s.length ? B64.indexOf(s[i + 1]) : -1;
    const c2 = i + 2 < s.length ? B64.indexOf(s[i + 2]) : -1;
    const c3 = i + 3 < s.length ? B64.indexOf(s[i + 3]) : -1;
    if (c0 < 0 || c1 < 0) throw new Error("bad b64url");
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0) out[o++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (c3 >= 0) out[o++] = ((c2 & 3) << 6) | c3;
  }
  return out.subarray(0, o);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signSession(
  data: Omit<SessionPayload, "iat" | "exp">,
  secret: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = { ...data, iat: now, exp: now + SESSION_MAX_AGE };
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body))
  );
  return body + "." + b64urlEncode(sig);
}

export async function verifySession(
  token: string | null | undefined,
  secret: string
): Promise<SessionPayload | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  try {
    const body = token.slice(0, dot);
    const sig = b64urlDecode(token.slice(dot + 1));
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, encoder.encode(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.email) return null;
    return payload;
  } catch {
    return null;
  }
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
