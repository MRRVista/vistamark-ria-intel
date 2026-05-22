/**
 * Shared HTTP helpers for external data sources.
 *
 * - politeFetch: identifies as Vistamark, retries on 5xx + network errors, modest backoff.
 *   ProPublica and IRS both expect a real User-Agent; missing UA can trigger blocks.
 * - jsonFetch:   politeFetch + JSON parse + status-OK guard.
 */

const USER_AGENT =
  process.env.VISTAMARK_USER_AGENT ??
  "Vistamark Intel (vistamark-ria-intel; mrice@vistamarkllc.com)";

export interface PoliteFetchOptions extends RequestInit {
  retries?: number;        // default 3
  retryDelayMs?: number;   // default 500
  timeoutMs?: number;      // default 30000
}

export async function politeFetch(url: string, init: PoliteFetchOptions = {}): Promise<Response> {
  const {
    retries = 3,
    retryDelayMs = 500,
    timeoutMs = 30000,
    headers,
    ...rest
  } = init;

  const merged: RequestInit = {
    ...rest,
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json, text/csv;q=0.9, */*;q=0.1",
      ...(headers ?? {}),
    },
  };

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...merged, signal: controller.signal });
      clearTimeout(timer);
      // Retry on 429 and 5xx; surface 4xx immediately so callers can handle 404 etc.
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        if (attempt < retries) {
          await sleep(retryDelayMs * Math.pow(2, attempt));
          continue;
        }
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(retryDelayMs * Math.pow(2, attempt));
        continue;
      }
    }
  }
  throw lastErr ?? new Error(`politeFetch failed after ${retries + 1} attempts: ${url}`);
}

export async function jsonFetch<T = unknown>(
  url: string,
  init: PoliteFetchOptions = {}
): Promise<T> {
  const res = await politeFetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
