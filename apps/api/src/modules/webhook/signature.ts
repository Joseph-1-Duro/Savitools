import { createHmac, timingSafeEqual } from 'crypto';

export const SIGNATURE_HEADER = 'X-SaviTools-Signature';
export const TIMESTAMP_HEADER = 'X-SaviTools-Timestamp';

/**
 * Header the pre-timestamped Webhook Tester used to emit. Its signature covered
 * the body alone, which a `verifySignature` receiver rejects outright. Kept only
 * so recorded legacy deliveries can be recognised and migrated; never emitted.
 */
export const LEGACY_SIGNATURE_HEADER = 'X-Webhook-Signature';

/** ISO-8601 companion header the legacy Webhook Tester emitted alongside it. */
export const LEGACY_ISO_TIMESTAMP_HEADER = 'X-Timestamp';

/**
 * Oldest signature a verifier will accept. Anything older is treated as a
 * replayed request and rejected.
 */
export const DEFAULT_MAX_AGE_SECONDS = 300;

/**
 * How far ahead of the verifier's clock a timestamp may be before it is
 * rejected. Covers a sender's clock running fast without widening the replay
 * window on the stale side.
 */
export const DEFAULT_MAX_SKEW_SECONDS = 60;

export interface SignedHeaders {
  /** Value for SIGNATURE_HEADER, e.g. `sha256=<hex>`. */
  signature: string;
  /** Value for TIMESTAMP_HEADER: integer Unix seconds. */
  timestamp: string;
}

export interface VerifySignatureOptions {
  secret: string;
  /** The exact request body bytes as sent / received over the wire. */
  body: string | Buffer;
  /** Raw value of SIGNATURE_HEADER, e.g. `sha256=<hex>`. */
  signature?: string;
  /** Raw value of TIMESTAMP_HEADER: integer Unix seconds. */
  timestamp?: string;
  maxAgeSeconds?: number;
  maxSkewSeconds?: number;
  /** Injectable clock for deterministic tests; defaults to the real time. */
  now?: number;
}

export type SignatureVerificationReason =
  | 'missing-signature'
  | 'missing-timestamp'
  | 'malformed-timestamp'
  | 'expired'
  | 'future'
  | 'invalid-signature';

export interface SignatureVerificationResult {
  valid: boolean;
  reason?: SignatureVerificationReason;
}

export interface WebhookSigningStatus {
  enabled: boolean;
  algorithm: 'hmac-sha256';
  signatureHeader: string;
  timestampHeader: string;
  replayWindowSeconds: number;
  /**
   * Exact string the HMAC is computed over. Stated so receivers implement the
   * documented contract rather than the pre-timestamped body-only format.
   */
  signedPayloadFormat: string;
  /** Format of the SIGNATURE_HEADER value, e.g. `sha256=<hex>`. */
  signatureFormat: string;
  /** Encoding the signed payload is serialised in. */
  signedPayloadEncoding: 'utf-8';
  /** How far ahead of the verifier's clock a timestamp may be. */
  maxSkewSeconds: number;
  /**
   * Whether a caller-supplied per-request secret also enables signing, i.e.
   * signing can be on for one delivery while `enabled` is false.
   */
  perRequestSecretSupported: boolean;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Signs an outbound webhook body: hex HMAC-SHA256 over the UTF-8 bytes of
 * `<timestamp>.<body>`. The timestamp (integer Unix seconds) is emitted
 * alongside it in TIMESTAMP_HEADER so a receiver can verify the signature
 * and bound its age, which prevents replaying a captured request verbatim.
 *
 * The body is hashed exactly as it is put on the wire: callers pass the same
 * string (or Buffer) they send as the request body.
 */
export function signBody(options: {
  secret: string;
  body: string | Buffer;
  timestamp?: number;
}): SignedHeaders {
  const timestamp = options.timestamp ?? nowSeconds();
  const mac = createHmac('sha256', options.secret);
  mac.update(`${timestamp}.`);
  mac.update(options.body);
  return { signature: `sha256=${mac.digest('hex')}`, timestamp: String(timestamp) };
}

/**
 * The one wire contract every outbound path uses: the same header pair, built
 * from the same bytes that go on the wire. Callers must pass the body string
 * (or Buffer) they hand to `fetch` unchanged — signing a re-serialised copy is
 * how the body-only format regressed in the first place.
 */
export function signatureHeaders(options: {
  secret: string;
  body: string | Buffer;
  timestamp?: number;
}): Record<string, string> {
  const signed = signBody(options);
  return {
    [SIGNATURE_HEADER]: signed.signature,
    [TIMESTAMP_HEADER]: signed.timestamp,
  };
}

/** Whether a recorded request's headers are from the pre-timestamped format. */
export function isLegacySignedRequest(headers: Record<string, string>): boolean {
  const lowered = Object.keys(headers).map((name) => name.toLowerCase());
  return (
    lowered.includes(LEGACY_SIGNATURE_HEADER.toLowerCase()) ||
    lowered.includes(LEGACY_ISO_TIMESTAMP_HEADER.toLowerCase())
  );
}

/** Describes the signing contract a receiver should implement. */
export function signingStatus(options: {
  enabled: boolean;
  replayWindowSeconds?: number;
  maxSkewSeconds?: number;
}): WebhookSigningStatus {
  return {
    enabled: options.enabled,
    algorithm: 'hmac-sha256',
    signatureHeader: SIGNATURE_HEADER,
    timestampHeader: TIMESTAMP_HEADER,
    replayWindowSeconds: options.replayWindowSeconds ?? DEFAULT_MAX_AGE_SECONDS,
    signedPayloadFormat: '<timestamp>.<body>',
    signatureFormat: 'sha256=<hex>',
    signedPayloadEncoding: 'utf-8',
    maxSkewSeconds: options.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS,
    perRequestSecretSupported: true,
  };
}

/**
 * Verifies a timestamped HMAC-SHA256 signature as a receiving endpoint would.
 * Checks, in order: presence of both headers, well-formed timestamp, age
 * within the replay window (and not implausibly far in the future), then a
 * constant-time comparison of the presented signature against the recomputed
 * one. Returns `{ valid: true }` or `{ valid: false, reason }`.
 */
export function verifySignature(options: VerifySignatureOptions): SignatureVerificationResult {
  const { secret, body, signature, timestamp } = options;

  if (!signature) return { valid: false, reason: 'missing-signature' };
  if (!timestamp) return { valid: false, reason: 'missing-timestamp' };
  if (!/^\d+$/.test(timestamp)) return { valid: false, reason: 'malformed-timestamp' };

  const now = options.now ?? nowSeconds();
  const maxAge = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  const maxSkew = options.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  const sentAt = Number(timestamp);

  if (now - sentAt > maxAge) return { valid: false, reason: 'expired' };
  if (sentAt - now > maxSkew) return { valid: false, reason: 'future' };

  const match = /^sha256=([0-9a-f]{64})$/.exec(signature);
  if (!match) return { valid: false, reason: 'invalid-signature' };

  const expected = signBody({ secret, body, timestamp: sentAt });
  const expectedHex = expected.signature.slice('sha256='.length);
  const expectedBytes = Buffer.from(expectedHex, 'hex');
  const receivedBytes = Buffer.from(match[1], 'hex');
  // Both are 32 bytes by construction (64 hex chars), so timingSafeEqual
  // never throws here; it just makes the comparison constant-time.
  const equal = timingSafeEqual(receivedBytes, expectedBytes);
  if (!equal) return { valid: false, reason: 'invalid-signature' };

  return { valid: true };
}