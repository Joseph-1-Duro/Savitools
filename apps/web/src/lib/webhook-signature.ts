/**
 * Browser mirror of the API's outbound webhook signing contract
 * (`apps/api/src/modules/webhook/signature.ts`). The Webhook Tester has to
 * reproduce the API's bytes exactly — over the serialised payload, not the
 * pretty-printed editor text — so a receiver can verify with one implementation
 * regardless of which path produced the delivery.
 */

export const SIGNATURE_HEADER = "X-SaviTools-Signature";
export const TIMESTAMP_HEADER = "X-SaviTools-Timestamp";

/** Pre-timestamped format, recognised so its recorded history can be explained. */
export const LEGACY_SIGNATURE_HEADER = "X-Webhook-Signature";
export const LEGACY_ISO_TIMESTAMP_HEADER = "X-Timestamp";

/**
 * The exact body bytes the API signs and sends. The API stringifies the parsed
 * payload object, so the browser must do the same rather than signing whatever
 * indentation the editor happens to hold.
 */
export function canonicalRequestBody(payload: unknown): string {
  return JSON.stringify(payload);
}

/** The exact string the HMAC covers: timestamp, a dot, then the body bytes. */
export function signedPayload(timestamp: string | number, body: string): string {
  return `${timestamp}.${body}`;
}

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hex HMAC-SHA256 of the UTF-8 bytes of `<timestamp>.<body>`, in the
 * `sha256=<hex>` form the API sends. Resolves to null when WebCrypto is
 * unavailable (an insecure context), so callers can degrade to "unsigned"
 * rather than render a wrong value.
 */
export async function signPayload(
  secret: string,
  timestamp: string | number,
  body: string,
): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;

  try {
    const key = await subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = await subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(signedPayload(timestamp, body)),
    );
    return `sha256=${toHex(signature)}`;
  } catch {
    return null;
  }
}

/** Current Unix second, the same clock the API signs against. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Whether a recorded request's headers came from the pre-timestamped format. */
export function isLegacySignedRequest(headers: Record<string, string>): boolean {
  const lowered = Object.keys(headers).map((name) => name.toLowerCase());
  return (
    lowered.includes(LEGACY_SIGNATURE_HEADER.toLowerCase()) ||
    lowered.includes(LEGACY_ISO_TIMESTAMP_HEADER.toLowerCase())
  );
}
