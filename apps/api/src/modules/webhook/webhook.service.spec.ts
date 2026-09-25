import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { createHmac } from 'crypto';
import { WebhookService, MAX_RESPONSE_BODY_BYTES, REDACTED, WebhookHistoryEntry } from './webhook.service';
import {
  LEGACY_ISO_TIMESTAMP_HEADER,
  LEGACY_SIGNATURE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySignature,
} from './signature';

const PUBLIC_IP_1 = '93.184.216.34';
const PUBLIC_IP_2 = '198.51.100.7';

/** Same known answer as `signature.spec.ts`, for the same secret/body/timestamp. */
const SECRET = 'whsec_test-secret-123';
const KAT_PAYLOAD = { event: 'campaign.funded', amount: '1000' };
const KAT_BODY = JSON.stringify(KAT_PAYLOAD);
const KAT_TIMESTAMP = 1_700_000_000;
const KAT_SIGNATURE =
  'sha256=8fdd9825bcf035086dfda168a689ff2386e1bf78eb255579bc6bbe2fe2ed590a';

function urlFor(ip: string, path = '/hook'): string {
  return `http://${ip}${path}`;
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location },
  });
}

function bodyResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers });
}

function streamResponse(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

describe('WebhookService', () => {
  let service: WebhookService;
  let fetchMock: jest.Mock;
  let envConfig: Record<string, string | undefined>;

  beforeEach(async () => {
    envConfig = {};
    const configService = {
      get: jest.fn((key: string) => envConfig[key]),
    } as unknown as ConfigService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [WebhookService, { provide: ConfigService, useValue: configService }],
    }).compile();

    service = module.get<WebhookService>(WebhookService);
    fetchMock = jest.fn();
    (global as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
    jest.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should return templates', () => {
    const templates = service.getTemplates();
    expect(templates.length).toBeGreaterThan(0);
  });

  it('should save and retrieve templates', () => {
    const customTemplate = {
      provider: 'crowdpay' as const,
      eventType: 'custom.event',
      description: 'Custom event test',
      schema: { test: 'string' },
      samplePayload: { test: true },
    };
    service.saveTemplate(customTemplate);
    const found = service.getTemplates().find((t) => t.eventType === 'custom.event');
    expect(found).toBeDefined();
    expect(found?.samplePayload).toEqual({ test: true });
  });

  describe('user isolation', () => {
    it('namespaces history by user and hides other users entries', async () => {
      fetchMock.mockResolvedValue(bodyResponse('ok'));

      await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'campaign.funded',
      });

      expect(service.getHistory('user-a')).toHaveLength(1);
      expect(service.getHistory('user-b')).toHaveLength(0);
    });

    it('rejects replay of another user’s history entry', async () => {
      fetchMock.mockResolvedValue(bodyResponse('ok'));

      const entry = (await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'campaign.funded',
      })) as { id: string };

      await expect(service.replayWebhook('user-b', entry.id)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('ssrf protection', () => {
    it('rejects private, loopback and metadata destinations without fetching', async () => {
      const forbidden = ['http://127.0.0.1/hook', 'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.10/hook', 'http://10.0.0.5/hook'];

      for (const endpointUrl of forbidden) {
        await expect(
          service.sendWebhook('user-a', { endpointUrl, eventType: 'e' }),
        ).rejects.toThrow(BadRequestException);
      }

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('follows redirects only after validating each hop', async () => {
      fetchMock
        .mockResolvedValueOnce(redirectResponse(urlFor(PUBLIC_IP_2, '/final')))
        .mockResolvedValueOnce(bodyResponse('done'));

      const entry = (await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'e',
      })) as { responseStatus: number | null };

      expect(entry.responseStatus).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0].toString()).toContain(PUBLIC_IP_2);
    });

    it('rejects redirects to private addresses', async () => {
      fetchMock.mockResolvedValueOnce(redirectResponse('http://127.0.0.1/steal'));

      await expect(
        service.sendWebhook('user-a', {
          endpointUrl: urlFor(PUBLIC_IP_1),
          eventType: 'e',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects redirects with non-HTTP(S) protocols', async () => {
      fetchMock.mockResolvedValueOnce(redirectResponse('ftp://example.com/payload'));

      await expect(
        service.sendWebhook('user-a', {
          endpointUrl: urlFor(PUBLIC_IP_1),
          eventType: 'e',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('stops following redirects beyond the allowed maximum', async () => {
      let call = 0;
      fetchMock.mockImplementation(() => {
        call += 1;
        return Promise.resolve(redirectResponse(urlFor(PUBLIC_IP_1, `/hop-${call}`)));
      });

      const entry = (await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'e',
      })) as { responseStatus: number | null };

      expect(fetchMock).toHaveBeenCalledTimes(6); // 5 followed redirects + the final 3xx
      expect(entry.responseStatus).toBe(302);
    });
  });

  describe('secret redaction', () => {
    it('redacts authorization, cookie, signature and secret-shaped headers before persistence', async () => {
      fetchMock.mockResolvedValue(
        bodyResponse('ok', { 'set-cookie': 'session=abc123; HttpOnly' }),
      );

      const entry = (await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'e',
        secret: 'shhh',
        headers: { Authorization: 'Bearer caller-token', 'X-Api-Key': 'abc123' },
      })) as { requestHeaders: Record<string, string>; responseHeaders: Record<string, string> };

      expect(entry.requestHeaders['Authorization']).toBe(REDACTED);
      expect(entry.requestHeaders['X-Api-Key']).toBe(REDACTED);
      expect(entry.requestHeaders[SIGNATURE_HEADER]).toBe(REDACTED);
      expect(entry.requestHeaders['Content-Type']).toBe('application/json');
      expect(entry.responseHeaders['set-cookie']).toBe(REDACTED);
      expect(JSON.stringify(entry)).not.toContain('caller-token');
      expect(JSON.stringify(entry)).not.toContain('abc123');
    });
  });

  describe('size limits', () => {
    it('truncates response bodies beyond the byte limit', async () => {
      const oversized = new TextEncoder().encode('a'.repeat(MAX_RESPONSE_BODY_BYTES + 1));
      fetchMock.mockResolvedValue(streamResponse([oversized]));

      const entry = (await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'e',
      })) as { responseBody: string; error?: string };

      expect(entry.responseBody.length).toBeLessThanOrEqual(MAX_RESPONSE_BODY_BYTES);
      expect(entry.error).toMatch(/truncated/i);
    });
  });

  describe('timestamped HMAC signing', () => {
    function sentHeaders(): Record<string, string> {
      return fetchMock.mock.calls[0][1].headers as Record<string, string>;
    }

    function sentBody(): string {
      return fetchMock.mock.calls[0][1].body as string;
    }

    it('matches the known answer for a pinned clock', async () => {
      jest.useFakeTimers().setSystemTime(KAT_TIMESTAMP * 1000);
      try {
        fetchMock.mockResolvedValue(bodyResponse('ok'));

        await service.sendWebhook('user-a', {
          endpointUrl: urlFor(PUBLIC_IP_1),
          eventType: 'campaign.funded',
          payload: KAT_PAYLOAD,
          secret: SECRET,
        });

        expect(sentBody()).toBe(KAT_BODY);
        expect(sentHeaders()[TIMESTAMP_HEADER]).toBe(String(KAT_TIMESTAMP));
        expect(sentHeaders()[SIGNATURE_HEADER]).toBe(KAT_SIGNATURE);
      } finally {
        jest.useRealTimers();
      }
    });

    it('emits the SaviTools header pair and never the legacy one', async () => {
      fetchMock.mockResolvedValue(bodyResponse('ok'));

      await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'campaign.funded',
        payload: KAT_PAYLOAD,
        secret: SECRET,
      });

      const headers = sentHeaders();
      expect(headers).toHaveProperty(SIGNATURE_HEADER);
      expect(headers).toHaveProperty(TIMESTAMP_HEADER);
      expect(headers).not.toHaveProperty(LEGACY_SIGNATURE_HEADER);
      expect(headers).not.toHaveProperty(LEGACY_ISO_TIMESTAMP_HEADER);
    });

    it('signs the exact bytes handed to fetch, not a re-serialised copy', async () => {
      fetchMock.mockResolvedValue(bodyResponse('ok'));

      await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'campaign.funded',
        payload: KAT_PAYLOAD,
        secret: SECRET,
      });

      // Recompute the way a receiver would: over the body it actually read.
      const verification = verifySignature({
        secret: SECRET,
        body: sentBody(),
        signature: sentHeaders()[SIGNATURE_HEADER],
        timestamp: sentHeaders()[TIMESTAMP_HEADER],
      });

      expect(verification).toEqual({ valid: true });
      // A re-serialised body (different key order or spacing) must not verify.
      const reserialised = JSON.stringify(JSON.parse(sentBody()), null, 2);
      expect(
        verifySignature({
          secret: SECRET,
          body: reserialised,
          signature: sentHeaders()[SIGNATURE_HEADER],
          timestamp: sentHeaders()[TIMESTAMP_HEADER],
        }),
      ).toEqual({ valid: false, reason: 'invalid-signature' });
    });

    it('never signs the body-only legacy format', async () => {
      fetchMock.mockResolvedValue(bodyResponse('ok'));

      await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'campaign.funded',
        payload: KAT_PAYLOAD,
        secret: SECRET,
      });

      const legacy = `sha256=${createHmac('sha256', SECRET).update(sentBody()).digest('hex')}`;
      expect(sentHeaders()[SIGNATURE_HEADER]).not.toBe(legacy);
    });

    it('records the timestamp and signed bytes so a receiver can recompute', async () => {
      jest.useFakeTimers().setSystemTime(KAT_TIMESTAMP * 1000);
      try {
        fetchMock.mockResolvedValue(bodyResponse('ok'));

        const entry = (await service.sendWebhook('user-a', {
          endpointUrl: urlFor(PUBLIC_IP_1),
          eventType: 'campaign.funded',
          payload: KAT_PAYLOAD,
          secret: SECRET,
        })) as WebhookHistoryEntry;

        expect(entry.signature).toEqual({
          timestamp: String(KAT_TIMESTAMP),
          body: KAT_BODY,
          signature: KAT_SIGNATURE,
        });
        expect(entry.legacySignature).toBeUndefined();
      } finally {
        jest.useRealTimers();
      }
    });

    it('signs with WEBHOOK_SIGNING_SECRET when no per-request secret is given', async () => {
      envConfig.WEBHOOK_SIGNING_SECRET = 'env-signing-secret';
      fetchMock.mockResolvedValue(bodyResponse('ok'));

      await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'campaign.funded',
        payload: KAT_PAYLOAD,
      });

      const headers = sentHeaders();
      expect(headers[TIMESTAMP_HEADER]).toMatch(/^\d+$/);
      expect(
        verifySignature({
          secret: 'env-signing-secret',
          body: sentBody(),
          signature: headers[SIGNATURE_HEADER],
          timestamp: headers[TIMESTAMP_HEADER],
        }),
      ).toEqual({ valid: true });
    });

    it('prefers the per-request secret over WEBHOOK_SIGNING_SECRET', async () => {
      envConfig.WEBHOOK_SIGNING_SECRET = 'env-signing-secret';
      fetchMock.mockResolvedValue(bodyResponse('ok'));

      await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'campaign.funded',
        payload: KAT_PAYLOAD,
        secret: 'per-request-secret',
      });

      const headers = sentHeaders();
      expect(
        verifySignature({
          secret: 'per-request-secret',
          body: sentBody(),
          signature: headers[SIGNATURE_HEADER],
          timestamp: headers[TIMESTAMP_HEADER],
        }),
      ).toEqual({ valid: true });
      expect(
        verifySignature({
          secret: 'env-signing-secret',
          body: sentBody(),
          signature: headers[SIGNATURE_HEADER],
          timestamp: headers[TIMESTAMP_HEADER],
        }),
      ).toEqual({ valid: false, reason: 'invalid-signature' });
    });

    it('does not let a caller-supplied header forge the signature', async () => {
      fetchMock.mockResolvedValue(bodyResponse('ok'));

      await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'campaign.funded',
        payload: KAT_PAYLOAD,
        secret: SECRET,
        headers: { [SIGNATURE_HEADER]: 'sha256=' + '0'.repeat(64), [TIMESTAMP_HEADER]: '1' },
      });

      const headers = sentHeaders();
      expect(headers[SIGNATURE_HEADER]).not.toBe('sha256=' + '0'.repeat(64));
      expect(
        verifySignature({
          secret: SECRET,
          body: sentBody(),
          signature: headers[SIGNATURE_HEADER],
          timestamp: headers[TIMESTAMP_HEADER],
        }),
      ).toEqual({ valid: true });
    });

    it('drops a legacy signature header a caller tries to add', async () => {
      fetchMock.mockResolvedValue(bodyResponse('ok'));

      await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'campaign.funded',
        payload: KAT_PAYLOAD,
        headers: {
          [LEGACY_SIGNATURE_HEADER]: `sha256=${createHmac('sha256', SECRET).update(KAT_BODY).digest('hex')}`,
          [LEGACY_ISO_TIMESTAMP_HEADER]: '2024-01-01T00:00:00.000Z',
          'X-Trace-Id': 'keep-me',
        },
      });

      const headers = sentHeaders();
      expect(headers).not.toHaveProperty(LEGACY_SIGNATURE_HEADER);
      expect(headers).not.toHaveProperty(LEGACY_ISO_TIMESTAMP_HEADER);
      expect(headers['X-Trace-Id']).toBe('keep-me');
    });

    it('omits both signing headers when no secret is configured', async () => {
      fetchMock.mockResolvedValue(bodyResponse('ok'));

      const entry = (await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'campaign.funded',
        payload: KAT_PAYLOAD,
      })) as WebhookHistoryEntry;

      const headers = sentHeaders();
      expect(headers).not.toHaveProperty(SIGNATURE_HEADER);
      expect(headers).not.toHaveProperty(TIMESTAMP_HEADER);
      expect(entry.signature).toBeUndefined();
    });

    it('signs each repeat independently with its own timestamp', async () => {
      fetchMock.mockResolvedValue(bodyResponse('ok'));

      await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'campaign.funded',
        payload: KAT_PAYLOAD,
        secret: SECRET,
        repeatCount: 2,
        repeatIntervalMs: 1,
      });

      const signatures = fetchMock.mock.calls.map(
        (call) => (call[1].headers as Record<string, string>)[SIGNATURE_HEADER],
      );
      expect(new Set(signatures).size).toBe(1); // same body, same second

      fetchMock.mock.calls.forEach((call) => {
        const headers = call[1].headers as Record<string, string>;
        expect(
          verifySignature({
            secret: SECRET,
            body: call[1].body as string,
            signature: headers[SIGNATURE_HEADER],
            timestamp: headers[TIMESTAMP_HEADER],
          }),
        ).toEqual({ valid: true });
      });
    });
  });

  describe('signing status', () => {
    it('reports the documented contract with signing disabled', () => {
      expect(service.getSigningStatus()).toEqual({
        enabled: false,
        algorithm: 'hmac-sha256',
        signatureHeader: 'X-SaviTools-Signature',
        timestampHeader: 'X-SaviTools-Timestamp',
        replayWindowSeconds: 300,
        signedPayloadFormat: '<timestamp>.<body>',
        signatureFormat: 'sha256=<hex>',
        signedPayloadEncoding: 'utf-8',
        maxSkewSeconds: 60,
        perRequestSecretSupported: true,
      });
    });

    it('reports signing as enabled once WEBHOOK_SIGNING_SECRET is configured', () => {
      envConfig.WEBHOOK_SIGNING_SECRET = 'env-signing-secret';

      expect(service.getSigningStatus()).toMatchObject({ enabled: true });
    });
  });

  describe('legacy deliveries', () => {
    /** Reproduces an entry recorded before the timestamped contract landed. */
    async function recordLegacyDelivery(): Promise<WebhookHistoryEntry> {
      fetchMock.mockResolvedValue(bodyResponse('ok'));
      const entry = (await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'campaign.funded',
        payload: KAT_PAYLOAD,
        secret: SECRET,
      })) as WebhookHistoryEntry;

      // Rewrite the recorded headers into the pre-timestamped shape an old
      // process would have persisted.
      const history = service.getHistory('user-a');
      const recorded = history.find((h) => h.id === entry.id)!;
      recorded.requestHeaders = {
        'Content-Type': 'application/json',
        [LEGACY_SIGNATURE_HEADER]: REDACTED,
        [LEGACY_ISO_TIMESTAMP_HEADER]: '2024-01-01T00:00:00.000Z',
      };
      delete recorded.signature;
      recorded.legacySignature = undefined;
      return recorded;
    }

    it('flags recorded legacy deliveries when history is read', async () => {
      const legacy = await recordLegacyDelivery();

      expect(service.getHistory('user-a').find((h) => h.id === legacy.id)?.legacySignature).toBe(true);
    });

    it('does not flag deliveries recorded under the current contract', async () => {
      fetchMock.mockResolvedValue(bodyResponse('ok'));
      await service.sendWebhook('user-a', {
        endpointUrl: urlFor(PUBLIC_IP_1),
        eventType: 'campaign.funded',
        payload: KAT_PAYLOAD,
        secret: SECRET,
      });

      expect(service.getHistory('user-a').every((h) => !h.legacySignature)).toBe(true);
    });

    it('re-signs a legacy replay under the current contract', async () => {
      envConfig.WEBHOOK_SIGNING_SECRET = 'env-signing-secret';
      const legacy = await recordLegacyDelivery();
      fetchMock.mockClear();

      await service.replayWebhook('user-a', legacy.id);

      const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
      const body = fetchMock.mock.calls[0][1].body as string;
      expect(headers).not.toHaveProperty(LEGACY_SIGNATURE_HEADER);
      expect(headers).not.toHaveProperty(LEGACY_ISO_TIMESTAMP_HEADER);
      expect(headers[TIMESTAMP_HEADER]).toMatch(/^\d+$/);
      expect(
        verifySignature({
          secret: 'env-signing-secret',
          body,
          signature: headers[SIGNATURE_HEADER],
          timestamp: headers[TIMESTAMP_HEADER],
        }),
      ).toEqual({ valid: true });
    });

    it('drops a stale timestamp carried by a recorded current-format entry', async () => {
      jest.useFakeTimers().setSystemTime(KAT_TIMESTAMP * 1000);
      try {
        envConfig.WEBHOOK_SIGNING_SECRET = 'env-signing-secret';
        fetchMock.mockResolvedValue(bodyResponse('ok'));
        const entry = (await service.sendWebhook('user-a', {
          endpointUrl: urlFor(PUBLIC_IP_1),
          eventType: 'campaign.funded',
          payload: KAT_PAYLOAD,
          secret: SECRET,
        })) as WebhookHistoryEntry;
        fetchMock.mockClear();

        jest.setSystemTime((KAT_TIMESTAMP + 60) * 1000);
        await service.replayWebhook('user-a', entry.id);

        const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
        const body = fetchMock.mock.calls[0][1].body as string;
        expect(headers[TIMESTAMP_HEADER]).toBe(String(KAT_TIMESTAMP + 60));
        expect(headers[TIMESTAMP_HEADER]).not.toBe(entry.signature?.timestamp);
        expect(
          verifySignature({
            secret: 'env-signing-secret',
            body,
            signature: headers[SIGNATURE_HEADER],
            timestamp: headers[TIMESTAMP_HEADER],
          }),
        ).toEqual({ valid: true });
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
