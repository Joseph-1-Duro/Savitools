import { createHmac } from 'crypto';
import {
  DEFAULT_MAX_AGE_SECONDS,
  DEFAULT_MAX_SKEW_SECONDS,
  LEGACY_ISO_TIMESTAMP_HEADER,
  LEGACY_SIGNATURE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  isLegacySignedRequest,
  signBody,
  signatureHeaders,
  signingStatus,
  verifySignature,
} from './signature';

const SECRET = 'whsec_test-secret-123';
const BODY = JSON.stringify({ event: 'campaign.funded', amount: '1000' });
const TS = 1_700_000_000; // fixed clock for deterministic tests

/**
 * Known answer, computed independently of the implementation:
 *   echo -n '1700000000.{"event":"campaign.funded","amount":"1000"}' \
 *     | openssl dgst -sha256 -hmac 'whsec_test-secret-123'
 * Every outbound path's spec asserts against this same literal, so a signing
 * change cannot quietly become a one-path-only change.
 */
const KAT_SIGNATURE =
  'sha256=8fdd9825bcf035086dfda168a689ff2386e1bf78eb255579bc6bbe2fe2ed590a';

describe('known answer', () => {
  it('matches an independently computed HMAC of `<timestamp>.<body>`', () => {
    expect(signBody({ secret: SECRET, body: BODY, timestamp: TS })).toEqual({
      signature: KAT_SIGNATURE,
      timestamp: String(TS),
    });
  });

  it('rejects the legacy body-only signature for the same secret and body', () => {
    // The pre-timestamped format a receiver used to see. It must not verify,
    // otherwise a verifier could not tell the two formats apart.
    const legacy = `sha256=${createHmac('sha256', SECRET).update(BODY).digest('hex')}`;

    expect(legacy).not.toBe(KAT_SIGNATURE);
    expect(
      verifySignature({
        secret: SECRET,
        body: BODY,
        signature: legacy,
        timestamp: String(TS),
        now: TS,
      }),
    ).toEqual({ valid: false, reason: 'invalid-signature' });
  });
});

describe('signatureHeaders', () => {
  it('returns the one documented header pair, and nothing else', () => {
    expect(signatureHeaders({ secret: SECRET, body: BODY, timestamp: TS })).toEqual({
      [SIGNATURE_HEADER]: KAT_SIGNATURE,
      [TIMESTAMP_HEADER]: String(TS),
    });
  });

  it('produces headers a receiver can verify from the body it received', () => {
    const headers = signatureHeaders({ secret: SECRET, body: BODY, timestamp: TS });

    expect(
      verifySignature({
        secret: SECRET,
        body: BODY,
        signature: headers[SIGNATURE_HEADER],
        timestamp: headers[TIMESTAMP_HEADER],
        now: TS,
      }),
    ).toEqual({ valid: true });
  });
});

describe('isLegacySignedRequest', () => {
  it('recognises headers recorded under the pre-timestamped format', () => {
    expect(
      isLegacySignedRequest({ [LEGACY_SIGNATURE_HEADER]: 'sha256=abc' }),
    ).toBe(true);
    expect(
      isLegacySignedRequest({ [LEGACY_ISO_TIMESTAMP_HEADER]: '2024-01-01T00:00:00Z' }),
    ).toBe(true);
    expect(
      isLegacySignedRequest({ 'x-webhook-signature': 'sha256=abc' }),
    ).toBe(true);
  });

  it('leaves current-format and unsigned requests alone', () => {
    const current = signatureHeaders({ secret: SECRET, body: BODY, timestamp: TS });

    expect(isLegacySignedRequest(current)).toBe(false);
    expect(isLegacySignedRequest({ 'Content-Type': 'application/json' })).toBe(false);
    expect(isLegacySignedRequest({})).toBe(false);
  });
});

describe('signingStatus', () => {
  it('describes the timestamped contract, not the legacy body-only format', () => {
    const status = signingStatus({ enabled: true });

    expect(status).toEqual({
      enabled: true,
      algorithm: 'hmac-sha256',
      signatureHeader: 'X-SaviTools-Signature',
      timestampHeader: 'X-SaviTools-Timestamp',
      replayWindowSeconds: DEFAULT_MAX_AGE_SECONDS,
      signedPayloadFormat: '<timestamp>.<body>',
      signatureFormat: 'sha256=<hex>',
      signedPayloadEncoding: 'utf-8',
      maxSkewSeconds: DEFAULT_MAX_SKEW_SECONDS,
      perRequestSecretSupported: true,
    });
    expect(status.signedPayloadFormat).toContain('timestamp');
  });

  it('honours an explicit window and reports signing as disabled', () => {
    expect(signingStatus({ enabled: false })).toMatchObject({ enabled: false });
    expect(
      signingStatus({ enabled: true, replayWindowSeconds: 60, maxSkewSeconds: 5 }),
    ).toMatchObject({ replayWindowSeconds: 60, maxSkewSeconds: 5 });
  });
});

describe('signBody', () => {
  it('emits sha256=<64 hex chars> covering `<timestamp>.<body>`', () => {
    const { signature, timestamp } = signBody({ secret: SECRET, body: BODY, timestamp: TS });

    expect(timestamp).toBe(String(TS));
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);

    const expected = createHmac('sha256', SECRET).update(`${TS}.${BODY}`).digest('hex');
    expect(signature).toBe(`sha256=${expected}`);
  });

  it('signs the exact body bytes sent over the wire', () => {
    const { signature } = signBody({ secret: SECRET, body: BODY, timestamp: TS });
    // A different-but-similar body must not verify against this signature.
    const tampered = signBody({ secret: SECRET, body: `${BODY} `, timestamp: TS });
    expect(tampered.signature).not.toBe(signature);
  });

  it('accepts a Buffer body and hashes its raw bytes', () => {
    const bodyBuffer = Buffer.from(BODY, 'utf8');
    const { signature } = signBody({ secret: SECRET, body: bodyBuffer, timestamp: TS });

    const expected = createHmac('sha256', SECRET)
      .update(`${TS}.`)
      .update(bodyBuffer)
      .digest('hex');
    expect(signature).toBe(`sha256=${expected}`);
  });

  it('defaults the timestamp to the current Unix second', () => {
    const before = Math.floor(Date.now() / 1000);
    const { timestamp } = signBody({ secret: SECRET, body: BODY });
    const after = Math.floor(Date.now() / 1000);

    expect(Number(timestamp)).toBeGreaterThanOrEqual(before);
    expect(Number(timestamp)).toBeLessThanOrEqual(after);
  });

  it('produces different signatures for different secrets and timestamps', () => {
    const a = signBody({ secret: SECRET, body: BODY, timestamp: TS });
    const b = signBody({ secret: 'other-secret', body: BODY, timestamp: TS });
    const c = signBody({ secret: SECRET, body: BODY, timestamp: TS + 1 });

    expect(a.signature).not.toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
  });
});

describe('verifySignature', () => {
  it('accepts a freshly signed, correctly formatted request', () => {
    const { signature, timestamp } = signBody({ secret: SECRET, body: BODY, timestamp: TS });

    expect(verifySignature({ secret: SECRET, body: BODY, signature, timestamp, now: TS })).toEqual({
      valid: true,
    });
  });

  it('verifies within the replay window at the exact max-age boundary', () => {
    const { signature, timestamp } = signBody({ secret: SECRET, body: BODY, timestamp: TS });

    expect(
      verifySignature({
        secret: SECRET,
        body: BODY,
        signature,
        timestamp,
        now: TS + DEFAULT_MAX_AGE_SECONDS,
      }),
    ).toEqual({ valid: true });
  });

  describe('failure paths', () => {
    it('rejects a missing signature header', () => {
      expect(
        verifySignature({ secret: SECRET, body: BODY, signature: undefined, timestamp: String(TS), now: TS }),
      ).toEqual({ valid: false, reason: 'missing-signature' });
    });

    it('rejects an empty signature header as missing', () => {
      expect(
        verifySignature({ secret: SECRET, body: BODY, signature: '', timestamp: String(TS), now: TS }),
      ).toEqual({ valid: false, reason: 'missing-signature' });
    });

    it('rejects a missing timestamp header', () => {
      const { signature } = signBody({ secret: SECRET, body: BODY, timestamp: TS });
      expect(
        verifySignature({ secret: SECRET, body: BODY, signature, timestamp: undefined, now: TS }),
      ).toEqual({ valid: false, reason: 'missing-timestamp' });
    });

    it('rejects a non-numeric timestamp', () => {
      const { signature } = signBody({ secret: SECRET, body: BODY, timestamp: TS });
      for (const bad of ['now', '17:00:00', '12.5', '-5']) {
        expect(
          verifySignature({ secret: SECRET, body: BODY, signature, timestamp: bad, now: TS }),
        ).toEqual({ valid: false, reason: 'malformed-timestamp' });
      }
    });

    it('rejects a signature older than the replay window (replay attack)', () => {
      const { signature, timestamp } = signBody({ secret: SECRET, body: BODY, timestamp: TS });

      expect(
        verifySignature({
          secret: SECRET,
          body: BODY,
          signature,
          timestamp,
          now: TS + DEFAULT_MAX_AGE_SECONDS + 1,
        }),
      ).toEqual({ valid: false, reason: 'expired' });
    });

    it('rejects a timestamp implausibly far in the future (sender clock skew)', () => {
      const { signature, timestamp } = signBody({ secret: SECRET, body: BODY, timestamp: TS });

      expect(
        verifySignature({
          secret: SECRET,
          body: BODY,
          signature,
          timestamp,
          now: TS - DEFAULT_MAX_SKEW_SECONDS - 1,
        }),
      ).toEqual({ valid: false, reason: 'future' });
    });

    it('accepts a timestamp within the allowed clock skew', () => {
      const { signature, timestamp } = signBody({ secret: SECRET, body: BODY, timestamp: TS });

      expect(
        verifySignature({
          secret: SECRET,
          body: BODY,
          signature,
          timestamp,
          now: TS - DEFAULT_MAX_SKEW_SECONDS,
        }),
      ).toEqual({ valid: true });
    });

    it('rejects a signature computed with the wrong secret', () => {
      const { signature, timestamp } = signBody({ secret: SECRET, body: BODY, timestamp: TS });

      expect(
        verifySignature({ secret: 'wrong-secret', body: BODY, signature, timestamp, now: TS }),
      ).toEqual({ valid: false, reason: 'invalid-signature' });
    });

    it('rejects a signature computed over a tampered body', () => {
      const { signature, timestamp } = signBody({ secret: SECRET, body: BODY, timestamp: TS });

      expect(
        verifySignature({ secret: SECRET, body: `${BODY}x`, signature, timestamp, now: TS }),
      ).toEqual({ valid: false, reason: 'invalid-signature' });
    });

    it('rejects a signature computed over a different timestamp', () => {
      const { signature } = signBody({ secret: SECRET, body: BODY, timestamp: TS });

      expect(
        verifySignature({ secret: SECRET, body: BODY, signature, timestamp: String(TS + 1), now: TS + 1 }),
      ).toEqual({ valid: false, reason: 'invalid-signature' });
    });

    it('rejects a malformed signature value', () => {
      const { timestamp } = signBody({ secret: SECRET, body: BODY, timestamp: TS });
      const malformed = ['sha256=', 'sha256=not-hex', 'sha256=abcd', 'v1=abcd'];

      for (const signature of malformed) {
        expect(
          verifySignature({ secret: SECRET, body: BODY, signature, timestamp, now: TS }),
        ).toEqual({ valid: false, reason: 'invalid-signature' });
      }
    });

    it('rejects a truncated signature (63 hex chars)', () => {
      const { signature, timestamp } = signBody({ secret: SECRET, body: BODY, timestamp: TS });
      const truncated = `sha256=${signature.slice('sha256='.length, -1)}`;

      expect(
        verifySignature({ secret: SECRET, body: BODY, signature: truncated, timestamp, now: TS }),
      ).toEqual({ valid: false, reason: 'invalid-signature' });
    });
  });

  it('never throws when presented arbitrary garbage (constant-time path)', () => {
    expect(() =>
      verifySignature({
        secret: SECRET,
        body: BODY,
        signature: 'sha256=zzzz',
        timestamp: 'nope',
        now: TS,
      }),
    ).not.toThrow();
  });
});

describe('header constants', () => {
  it('matches the documented wire format names', () => {
    expect(SIGNATURE_HEADER).toBe('X-SaviTools-Signature');
    expect(TIMESTAMP_HEADER).toBe('X-SaviTools-Timestamp');
  });

  it('keeps the legacy names recognisable but distinct from the current pair', () => {
    expect(LEGACY_SIGNATURE_HEADER).toBe('X-Webhook-Signature');
    expect(LEGACY_ISO_TIMESTAMP_HEADER).toBe('X-Timestamp');
    expect(LEGACY_SIGNATURE_HEADER).not.toBe(SIGNATURE_HEADER);
    expect(LEGACY_ISO_TIMESTAMP_HEADER).not.toBe(TIMESTAMP_HEADER);
  });
});
