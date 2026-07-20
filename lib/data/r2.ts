/**
 * Cloudflare R2 raw-file archive (S3-compatible API, SigV4 via aws4fetch).
 *
 * Snapshots bulk source files — today the DERA Form D quarterly zips — into
 * the intel bucket so every load is reproducible from the exact bytes we
 * ingested, with SHA-256 recorded by the caller (same raw-snapshot discipline
 * as the Wealthbox sync).
 *
 * No-op when the R2_* env vars are unset, so pipelines run fine without it.
 * NOTE: credentials live only in Vercel env vars — never in this public repo.
 *
 * Env:
 *   R2_ENDPOINT           https://<account_id>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY_ID
 *   R2_SECRET_ACCESS_KEY
 *   R2_BUCKET             optional, default "ria-intel-raw"
 */
import { createHash } from "crypto";
import { AwsClient } from "aws4fetch";

const endpoint = process.env.R2_ENDPOINT ?? "";
const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? "";
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? "";
const bucket = process.env.R2_BUCKET ?? "ria-intel-raw";

export const r2Configured = (): boolean =>
  Boolean(endpoint && accessKeyId && secretAccessKey);

export interface R2ArchiveResult {
  bucket: string;
  key: string;
  sha256: string;
  bytes: number;
}

let _client: AwsClient | null = null;
function client(): AwsClient {
  if (!_client) {
    _client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" });
  }
  return _client;
}

/** PUT bytes to r2://<bucket>/<key>. Returns null when R2 is not configured. */
export async function archiveToR2(
  key: string,
  body: Uint8Array,
  contentType: string
): Promise<R2ArchiveResult | null> {
  if (!r2Configured()) return null;
  const sha256 = createHash("sha256").update(body).digest("hex");
  const url = `${endpoint.replace(/\/+$/, "")}/${bucket}/${key}`;
  const res = await client().fetch(url, {
    method: "PUT",
    body,
    headers: { "Content-Type": contentType },
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`R2 PUT ${key} -> ${res.status}: ${detail}`);
  }
  return { bucket, key, sha256, bytes: body.byteLength };
}
