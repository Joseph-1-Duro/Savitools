import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { WebhookService, MAX_RESPONSE_BODY_BYTES, REDACTED } from './webhook.service';

const PUBLIC_IP_1 = '93.184.216.34';
const PUBLIC_IP_2 = '198.51.100.7';

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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WebhookService],
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
      expect(entry.requestHeaders['X-Webhook-Signature']).toBe(REDACTED);
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
});
