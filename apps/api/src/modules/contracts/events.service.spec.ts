import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Address, Contract, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signBody,
} from '../webhook/signature';

const lookupMock = jest.fn();
jest.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

const rpcServerMock = jest.fn();
jest.mock('../monitor/horizon', () => ({
  rpcServer: (...args: unknown[]) => rpcServerMock(...args),
}));

// Imported after the mocks so the module picks them up.
import { EventsService } from './events.service';
import { DecodedContractEvent } from './event-filters';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const OTHER_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const SECRET = 'shhh-this-is-a-secret';

/** Same known answer as the Webhook Tester and monitor delivery specs. */
const KAT_SECRET = 'whsec_test-secret-123';
const KAT_BODY = JSON.stringify({ id: 'evt-1', value: 1 });
const KAT_TIMESTAMP = 1_700_000_000;
const KAT_SIGNATURE =
  'sha256=12fe4dba685452576f41ccde070a2c5f2e213fee2a66ad5b38ce628c2de9953b';

function eventRecord(overrides: Partial<rpc.Api.EventResponse> = {}): rpc.Api.EventResponse {
  return {
    id: 'evt-1',
    type: 'contract',
    ledger: 100,
    ledgerClosedAt: '2024-01-01T00:00:00Z',
    pagingToken: 'token-1',
    inSuccessfulContractCall: true,
    txHash: 'tx-hash-1',
    contractId: new Contract(CONTRACT_ID),
    topic: [nativeToScVal('transfer', { type: 'symbol' })],
    value: nativeToScVal(1000n, { type: 'i128' }),
    ...overrides,
  } as rpc.Api.EventResponse;
}

function response(
  events: rpc.Api.EventResponse[],
  extra: Partial<rpc.Api.GetEventsResponse> = {},
): rpc.Api.GetEventsResponse {
  return { events, latestLedger: 500, cursor: 'next-cursor', ...extra };
}

function textResponse(status: number, body = ''): Response {
  return new Response(body, { status });
}

describe('EventsService', () => {
  let service: EventsService;
  let getEvents: jest.Mock;
  let getLatestLedger: jest.Mock;

  const configService = {
    get: jest.fn((_key: string, defaultValue?: string) => defaultValue),
    getOrThrow: jest.fn(),
  } as unknown as ConfigService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Restore the default config mock: nothing is configured unless a test says so.
    (configService.get as jest.Mock).mockImplementation(
      (_key: string, defaultValue?: string) => defaultValue,
    );
    getEvents = jest.fn().mockResolvedValue(response([eventRecord()]));
    getLatestLedger = jest.fn().mockResolvedValue({ sequence: 500 });
    rpcServerMock.mockReturnValue({ getEvents, getLatestLedger });

    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ address: '93.184.216.34' }]);

    service = new EventsService(configService);
  });

  describe('queryEvents', () => {
    it('rejects a malformed contract ID before touching the network', async () => {
      await expect(service.queryEvents({ contractId: 'not-a-contract' })).rejects.toThrow(
        BadRequestException,
      );
      expect(getEvents).not.toHaveBeenCalled();
    });

    it('decodes topics and values', async () => {
      const result = await service.queryEvents({ contractId: CONTRACT_ID, startLedger: 10 });

      expect(result.count).toBe(1);
      expect(result.latestLedger).toBe(500);
      expect(result.cursor).toBe('next-cursor');

      const [event] = result.events;
      expect(event.topic[0]).toMatchObject({ type: 'scvSymbol', value: 'transfer' });
      expect(event.value).toMatchObject({ type: 'scvI128', value: '1000' });
      expect(event.contractId).toBe(CONTRACT_ID);
      expect(event.txHash).toBe('tx-hash-1');
    });

    it('returns a JSON-serializable payload', async () => {
      getEvents.mockResolvedValue(
        response([
          eventRecord({
            value: xdr.ScVal.scvMap([
              new xdr.ScMapEntry({
                key: nativeToScVal('amount', { type: 'symbol' }),
                val: nativeToScVal(2n ** 90n, { type: 'u128' }),
              }),
            ]),
            topic: [nativeToScVal('transfer', { type: 'symbol' }), new Address(CONTRACT_ID).toScVal()],
          }),
        ]),
      );

      const result = await service.queryEvents({ contractId: CONTRACT_ID, startLedger: 10 });
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(result.events[0].value.value).toEqual({ amount: (2n ** 90n).toString() });
    });

    it('defaults to the contract event type and the requested limit', async () => {
      await service.queryEvents({ contractId: CONTRACT_ID, startLedger: 10, limit: 200 });

      expect(getEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: [{ type: 'contract', contractIds: [CONTRACT_ID] }],
          limit: 200,
          startLedger: 10,
        }),
      );
    });

    it('passes through a broadened event type', async () => {
      await service.queryEvents({ contractId: CONTRACT_ID, startLedger: 10, type: 'diagnostic' });

      expect(getEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: [{ type: 'diagnostic', contractIds: [CONTRACT_ID] }],
        }),
      );
    });

    it('falls back to the latest ledger when given no anchor', async () => {
      await service.queryEvents({ contractId: CONTRACT_ID });

      expect(getLatestLedger).toHaveBeenCalled();
      expect(getEvents).toHaveBeenCalledWith(expect.objectContaining({ startLedger: 500 }));
    });

    it('uses a cursor instead of a ledger anchor', async () => {
      await service.queryEvents({ contractId: CONTRACT_ID, cursor: 'abc' });

      expect(getLatestLedger).not.toHaveBeenCalled();
      const request = getEvents.mock.calls[0][0];
      expect(request.cursor).toBe('abc');
      expect(request.startLedger).toBeUndefined();
    });

    it('rejects startLedger and cursor together', async () => {
      await expect(
        service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1, cursor: 'abc' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an inverted ledger range', async () => {
      await expect(
        service.queryEvents({ contractId: CONTRACT_ID, startLedger: 200, endLedger: 100 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('maps mainnet to the public network at the rpcServer boundary', async () => {
      await service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1, network: 'mainnet' });
      expect(rpcServerMock).toHaveBeenCalledWith(configService, 'public');
    });

    it('maps testnet through unchanged', async () => {
      await service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1, network: 'testnet' });
      expect(rpcServerMock).toHaveBeenCalledWith(configService, 'testnet');
    });

    it('translates a retention-window error into a 400 naming the limit', async () => {
      getEvents.mockRejectedValue(
        new Error('startLedger must be within the ledger range: 1000 - 2000'),
      );

      await expect(
        service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1 }),
      ).rejects.toThrow(/retention window/i);
    });

    // The SDK rejects with a bare JSON-RPC object, not an Error. Verified
    // against live testnet: { code: -32600, message: 'startLedger must be
    // within the ledger range: 4257975 - 4378934' }.
    it('handles the SDK rejecting with a plain {code,message} object', async () => {
      getEvents.mockRejectedValue({
        code: -32600,
        message: 'startLedger must be within the ledger range: 4257975 - 4378934',
      });

      await expect(
        service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1000 }),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1000 }),
      ).rejects.toThrow(/4257975 - 4378934/);
    });

    it('never surfaces "[object Object]" for a non-Error rejection', async () => {
      getEvents.mockRejectedValue({ code: -32000, message: 'internal node failure' });

      await expect(
        service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1 }),
      ).rejects.toThrow(/internal node failure \(rpc code -32000\)/);

      await expect(
        service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1 }),
      ).rejects.not.toThrow(/\[object Object\]/);
    });

    it('falls back to JSON for an object with no message', async () => {
      getEvents.mockRejectedValue({ weird: true });

      await expect(
        service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1 }),
      ).rejects.toThrow(/\{"weird":true\}/);
    });

    it('translates other upstream failures into a 502', async () => {
      getEvents.mockRejectedValue(new Error('connect ECONNREFUSED'));

      await expect(
        service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1 }),
      ).rejects.toThrow(BadGatewayException);
    });

    it('handles an empty result set', async () => {
      getEvents.mockResolvedValue(response([]));
      const result = await service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1 });
      expect(result).toMatchObject({ events: [], count: 0 });
    });
  });

  describe('filterEvents', () => {
    it('narrows events and reports the count', async () => {
      const { events } = await service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1 });
      const result = service.filterEvents(events, [{ kind: 'topic_contains', value: 'transfer' }]);

      expect(result.count).toBe(1);
      expect(result.events[0].matchedCriteria).toEqual(['topic contains transfer']);
    });

    it('drops events that fail a criterion', async () => {
      const { events } = await service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1 });
      expect(service.filterEvents(events, [{ kind: 'topic_contains', value: 'burn' }]).count).toBe(0);
    });
  });

  describe('replayEvents', () => {
    const events = [{ id: 'evt-1', value: 1 }, { id: 'evt-2', value: 2 }];

    it('rejects a malformed URL', async () => {
      await expect(
        service.replayEvents({ webhookUrl: 'not a url', events }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a destination resolving to a private address', async () => {
      lookupMock.mockResolvedValue([{ address: '169.254.169.254' }]);
      global.fetch = jest.fn();

      await expect(
        service.replayEvents({ webhookUrl: 'http://metadata.internal/hook', events }),
      ).rejects.toThrow(BadRequestException);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('POSTs one request per event and reports success', async () => {
      global.fetch = jest.fn().mockResolvedValue(textResponse(200, 'ok'));

      const summary = await service.replayEvents({
        webhookUrl: 'https://example.com/hook',
        events,
      });

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(summary).toMatchObject({ delivered: 2, failed: 0 });
      expect(summary.results.map((r) => r.eventId)).toEqual(['evt-1', 'evt-2']);
      expect(summary.results.map((r) => r.index)).toEqual([0, 1]);
      expect(summary.results.every((r) => r.ok && r.statusCode === 200)).toBe(true);
    });

    it('signs each POST with a timestamped HMAC a receiver can recompute', async () => {
      const fetchMock = jest.fn().mockResolvedValue(textResponse(200));
      global.fetch = fetchMock;

      await service.replayEvents({
        webhookUrl: 'https://example.com/hook',
        secret: SECRET,
        events: [events[0]],
      });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      const body = init.body as string;

      // What a receiving endpoint would compute over raw body + timestamp.
      const expected = signBody({
        secret: SECRET,
        body,
        timestamp: Number(headers[TIMESTAMP_HEADER]),
      }).signature;

      expect(headers[TIMESTAMP_HEADER]).toMatch(/^\d+$/);
      expect(headers[SIGNATURE_HEADER]).toBe(expected);
      expect(JSON.parse(body)).toEqual(events[0]);
      expect(init.method).toBe('POST');
      expect(headers['Content-Type']).toBe('application/json');
    });

    it('signs each event independently with its own timestamp', async () => {
      const fetchMock = jest.fn().mockResolvedValue(textResponse(200));
      global.fetch = fetchMock;

      await service.replayEvents({
        webhookUrl: 'https://example.com/hook',
        secret: SECRET,
        events,
      });

      const signatures = fetchMock.mock.calls.map((call) => {
        const init = call[1] as RequestInit;
        return (init.headers as Record<string, string>)[SIGNATURE_HEADER];
      });

      expect(signatures[0]).not.toBe(signatures[1]);
      fetchMock.mock.calls.forEach((call) => {
        const init = call[1] as RequestInit;
        const headers = init.headers as Record<string, string>;
        const body = init.body as string;
        const sig = headers[SIGNATURE_HEADER];
        expect(sig).toBe(
          signBody({
            secret: SECRET,
            body,
            timestamp: Number(headers[TIMESTAMP_HEADER]),
          }).signature,
        );
      });
    });

    it('signs with WEBHOOK_SIGNING_SECRET when no per-request secret is given', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) =>
        key === 'WEBHOOK_SIGNING_SECRET' ? 'env-signing-secret' : undefined,
      );
      const fetchMock = jest.fn().mockResolvedValue(textResponse(200));
      global.fetch = fetchMock;

      await service.replayEvents({
        webhookUrl: 'https://example.com/hook',
        events: [events[0]],
      });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      const body = init.body as string;

      expect(headers[SIGNATURE_HEADER]).toBe(
        signBody({
          secret: 'env-signing-secret',
          body,
          timestamp: Number(headers[TIMESTAMP_HEADER]),
        }).signature,
      );
    });

    it('prefers the per-request secret over WEBHOOK_SIGNING_SECRET', async () => {
      (configService.get as jest.Mock).mockImplementation((key: string) =>
        key === 'WEBHOOK_SIGNING_SECRET' ? 'env-signing-secret' : undefined,
      );
      const fetchMock = jest.fn().mockResolvedValue(textResponse(200));
      global.fetch = fetchMock;

      await service.replayEvents({
        webhookUrl: 'https://example.com/hook',
        secret: SECRET,
        events: [events[0]],
      });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      const body = init.body as string;

      expect(headers[SIGNATURE_HEADER]).toBe(
        signBody({
          secret: SECRET,
          body,
          timestamp: Number(headers[TIMESTAMP_HEADER]),
        }).signature,
      );
    });

    it('omits the signature header when no secret is supplied', async () => {
      const fetchMock = jest.fn().mockResolvedValue(textResponse(200));
      global.fetch = fetchMock;

      await service.replayEvents({ webhookUrl: 'https://example.com/hook', events: [events[0]] });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      expect(init.headers as Record<string, string>).not.toHaveProperty('X-SaviTools-Signature');
    });

    it('matches the known answer for a pinned clock', async () => {
      // Same secret, body and timestamp as the other outbound paths' vectors,
      // so all three must produce one signature for one body.
      jest.useFakeTimers().setSystemTime(KAT_TIMESTAMP * 1000);
      try {
        const fetchMock = jest.fn().mockResolvedValue(textResponse(200));
        global.fetch = fetchMock;

        await service.replayEvents({
          webhookUrl: 'https://example.com/hook',
          secret: KAT_SECRET,
          events: [{ id: 'evt-1', value: 1 }],
        });

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        const headers = init.headers as Record<string, string>;

        expect(init.body).toBe(KAT_BODY);
        expect(headers[TIMESTAMP_HEADER]).toBe(String(KAT_TIMESTAMP));
        expect(headers[SIGNATURE_HEADER]).toBe(KAT_SIGNATURE);
      } finally {
        jest.useRealTimers();
      }
    });

    it('emits the SaviTools header pair and never the legacy one', async () => {
      const fetchMock = jest.fn().mockResolvedValue(textResponse(200));
      global.fetch = fetchMock;

      await service.replayEvents({
        webhookUrl: 'https://example.com/hook',
        secret: SECRET,
        events: [events[0]],
      });

      const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers).toHaveProperty(SIGNATURE_HEADER);
      expect(headers).toHaveProperty(TIMESTAMP_HEADER);
      expect(headers).not.toHaveProperty('X-Webhook-Signature');
      expect(headers).not.toHaveProperty('X-Timestamp');
    });

    it('records a per-event failure without failing the batch', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(textResponse(200))
        .mockRejectedValueOnce(new Error('Network error'));

      const summary = await service.replayEvents({
        webhookUrl: 'https://example.com/hook',
        events,
      });

      expect(summary.delivered).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.results[1]).toMatchObject({ ok: false, error: 'Network error', statusCode: null });
    });

    it('counts a non-2xx response as failed but still reports its status', async () => {
      global.fetch = jest.fn().mockResolvedValue(textResponse(500, 'boom'));

      const summary = await service.replayEvents({
        webhookUrl: 'https://example.com/hook',
        events: [events[0]],
      });

      expect(summary).toMatchObject({ delivered: 0, failed: 1 });
      expect(summary.results[0]).toMatchObject({ ok: false, statusCode: 500 });
    });

    it('re-validates a redirect hop before following it', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: 'https://elsewhere.com/hook' } }),
        )
        .mockResolvedValueOnce(textResponse(200));

      const summary = await service.replayEvents({
        webhookUrl: 'https://example.com/hook',
        events: [events[0]],
      });

      expect(summary.delivered).toBe(1);
      // Once for the initial destination, once for the redirect target.
      expect(lookupMock).toHaveBeenCalledTimes(2);
      expect(lookupMock).toHaveBeenLastCalledWith('elsewhere.com', expect.anything());
    });

    it('refuses a redirect into a private address', async () => {
      lookupMock
        .mockResolvedValueOnce([{ address: '93.184.216.34' }])
        .mockResolvedValueOnce([{ address: '127.0.0.1' }]);

      global.fetch = jest.fn().mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://localhost/hook' } }),
      );

      const summary = await service.replayEvents({
        webhookUrl: 'https://example.com/hook',
        events: [events[0]],
      });

      expect(summary.failed).toBe(1);
      expect(summary.results[0].error).toMatch(/non-public address/i);
    });
  });

  describe('decoded events flow into the filter engine', () => {
    it('filters events straight off a query', async () => {
      getEvents.mockResolvedValue(
        response([
          eventRecord({ id: 'a', ledger: 10 }),
          eventRecord({
            id: 'b',
            ledger: 20,
            topic: [nativeToScVal('mint', { type: 'symbol' })],
            contractId: new Contract(OTHER_CONTRACT),
          }),
        ]),
      );

      const { events } = await service.queryEvents({ contractId: CONTRACT_ID, startLedger: 1 });
      const filtered: DecodedContractEvent[] = service.filterEvents(events, [
        { kind: 'ledger_range', from: 15 },
      ]).events;

      expect(filtered.map((e) => e.id)).toEqual(['b']);
      expect(filtered[0].contractId).toBe(OTHER_CONTRACT);
    });
  });
});
