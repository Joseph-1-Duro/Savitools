import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  canonicalRequestBody,
  isLegacySignedRequest,
  nowSeconds,
  signPayload,
  signedPayload,
} from "@/lib/webhook-signature";

const SECRET = "whsec_test-secret-123";
const BODY = JSON.stringify({ event: "campaign.funded", amount: "1000" });
const TS = 1_700_000_000;

/**
 * Known answer, shared with the API suites so a browser/API divergence fails
 * both sides:
 *   echo -n '1700000000.{"event":"campaign.funded","amount":"1000"}' \
 *     | openssl dgst -sha256 -hmac 'whsec_test-secret-123'
 */
const KAT_SIGNATURE =
  "sha256=8fdd9825bcf035086dfda168a689ff2386e1bf78eb255579bc6bbe2fe2ed590a";

describe("webhook signing mirror", () => {
  it("uses the documented header names", () => {
    expect(SIGNATURE_HEADER).toBe("X-SaviTools-Signature");
    expect(TIMESTAMP_HEADER).toBe("X-SaviTools-Timestamp");
  });

  it("matches the API known answer for the same secret, body and timestamp", async () => {
    await expect(signPayload(SECRET, TS, BODY)).resolves.toBe(KAT_SIGNATURE);
  });

  it("signs `<timestamp>.<body>`, not the body alone", async () => {
    const signed = await signPayload(SECRET, TS, BODY);

    expect(signed).not.toBe(await signPayload(SECRET, TS, ""));
    // A different timestamp is a different payload, so a different signature.
    expect(signed).not.toBe(await signPayload(SECRET, TS + 1, BODY));
  });

  it("signs the canonical body, not pretty-printed editor text", async () => {
    const payload = { event: "campaign.funded", amount: "1000" };
    const editorText = JSON.stringify(payload, null, 2);
    const canonical = canonicalRequestBody(payload);

    expect(canonical).toBe(BODY);
    expect(editorText).not.toBe(canonical);
    // Signing the editor's bytes would not match what the API sends.
    expect(await signPayload(SECRET, TS, canonical)).toBe(KAT_SIGNATURE);
    expect(await signPayload(SECRET, TS, editorText)).not.toBe(KAT_SIGNATURE);
  });

  it("builds the signed payload from timestamp, a dot, and the body", () => {
    expect(signedPayload(TS, BODY)).toBe(`${TS}.${BODY}`);
    expect(signedPayload(String(TS), BODY)).toBe(signedPayload(TS, BODY));
  });

  it("signs non-ASCII bodies as UTF-8", async () => {
    const body = canonicalRequestBody({ event: "paiement.reçu", amount: "10" });

    // Independently computed: HMAC-SHA256 over the UTF-8 bytes of
    // `1700000000.{"event":"paiement.reçu","amount":"10"}`.
    expect(await signPayload(SECRET, TS, body)).toBe(
      "sha256=fb66ab69464604ee91ee41b6c05a2a8d6f6eb87315acda1307fa2f5e656891d6",
    );
  });

  it("resolves to null when WebCrypto is unavailable", async () => {
    const original = globalThis.crypto;
    // @ts-expect-error - simulating an insecure context without WebCrypto
    globalThis.crypto = undefined;
    try {
      await expect(signPayload(SECRET, TS, BODY)).resolves.toBeNull();
    } finally {
      globalThis.crypto = original;
    }
  });

  it("reports the current Unix second", () => {
    jest.useFakeTimers().setSystemTime(TS * 1000);
    try {
      expect(nowSeconds()).toBe(TS);
    } finally {
      jest.useRealTimers();
    }
  });

  it("recognises legacy recorded headers", () => {
    expect(isLegacySignedRequest({ "X-Webhook-Signature": "sha256=abc" })).toBe(true);
    expect(isLegacySignedRequest({ "X-Timestamp": "2024-01-01T00:00:00.000Z" })).toBe(true);
    expect(
      isLegacySignedRequest({
        [SIGNATURE_HEADER]: KAT_SIGNATURE,
        [TIMESTAMP_HEADER]: String(TS),
      }),
    ).toBe(false);
    expect(isLegacySignedRequest({})).toBe(false);
  });
});
