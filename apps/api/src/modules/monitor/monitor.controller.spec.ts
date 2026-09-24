import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { HttpStatus } from '@nestjs/common';
import { validate, plainToInstance } from 'class-validator';
import { MonitorController } from './monitor.controller';
import { MonitorService } from './monitor.service';
import { SearchEventsQueryDto } from './dto/search-events.dto';
import { ExportEventsQueryDto } from './dto/export-events.dto';
import type { FastifyReply } from 'fastify';

describe('MonitorController SSE and Metrics', () => {
  let controller: MonitorController;
  let configService: ConfigService;

  const mockMonitorService = {
    createWatch: jest.fn(),
    listWatches: jest.fn(),
    getWatch: jest.fn(),
    deleteWatch: jest.fn(),
    getWatchEvents: jest.fn(),
    getAlertEvents: jest.fn(),
    registerWebhook: jest.fn(),
    getWebhook: jest.fn(),
    searchEvents: jest.fn(),
    streamSearchEventsCsv: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: any) => {
      if (key === 'MAX_SSE_CONNECTIONS') return '2';
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MonitorController],
      providers: [
        { provide: MonitorService, useValue: mockMonitorService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    controller = module.get<MonitorController>(MonitorController);
    configService = module.get<ConfigService>(ConfigService);
  });

  it('exposes metrics via /metrics endpoint', () => {
    const metrics = controller.getMetrics();
    expect(metrics).toEqual({
      activeSseConnections: 0,
      maxSseConnections: 2,
    });
  });

  it('returns 503 when SSE connections exceed the configured MAX_SSE_CONNECTIONS limit', async () => {
    const createFakeReply = () => {
      return {
        raw: {
          setHeader: jest.fn(),
          flushHeaders: jest.fn(),
          write: jest.fn(),
          on: jest.fn(),
          writableEnded: false,
          end: jest.fn(),
        },
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      } as unknown as FastifyReply;
    };

    const reply1 = createFakeReply();
    const reply2 = createFakeReply();
    const reply3 = createFakeReply();

    await controller.stream(reply1);
    await controller.stream(reply2);

    expect(controller.getMetrics().activeSseConnections).toBe(2);

    await controller.stream(reply3);

    expect(reply3.status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(reply3.send).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'Maximum SSE connections reached',
      }),
    );
  });

  it('cleans up connections on client disconnect', async () => {
    const rawListeners: Record<string, Function> = {};
    const reply = {
      raw: {
        setHeader: jest.fn(),
        flushHeaders: jest.fn(),
        write: jest.fn(),
        on: jest.fn((event: string, fn: Function) => {
          rawListeners[event] = fn;
        }),
        writableEnded: false,
        end: jest.fn(),
      },
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    } as unknown as FastifyReply;

    await controller.stream(reply);
    expect(controller.getMetrics().activeSseConnections).toBe(1);

    // Simulate client close/disconnect
    rawListeners['close']?.();

    expect(controller.getMetrics().activeSseConnections).toBe(0);
  });
});

describe('MonitorController search & CSV export (Savitura/Savitools#195)', () => {
  let controller: MonitorController;

  const mockMonitorService = {
    createWatch: jest.fn(),
    listWatches: jest.fn(),
    getWatch: jest.fn(),
    deleteWatch: jest.fn(),
    getWatchEvents: jest.fn(),
    getAlertEvents: jest.fn(),
    registerWebhook: jest.fn(),
    getWebhook: jest.fn(),
    searchEvents: jest.fn(),
    streamSearchEventsCsv: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: any) => defaultValue),
  };

  function createFakeReply() {
    const writes: string[] = [];
    return {
      writes,
      raw: {
        setHeader: jest.fn(),
        write: jest.fn((chunk: string) => writes.push(chunk)),
        writableEnded: false,
        end: jest.fn(),
      },
    } as unknown as FastifyReply & { writes: string[] };
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MonitorController],
      providers: [
        { provide: MonitorService, useValue: mockMonitorService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    controller = module.get<MonitorController>(MonitorController);
  });

  it('delegates search to the service scoped to the authenticated user', async () => {
    const user = { id: 'user-1', email: 'user-1@example.com' } as any;
    const query = { watchId: 'watch-1', page: 1, limit: 25 } as SearchEventsQueryDto;
    mockMonitorService.searchEvents.mockResolvedValue({
      items: [],
      page: 1,
      limit: 25,
      total: 0,
    });

    await controller.searchEvents(user, query);

    // Ownership is enforced by passing only the current user's id.
    expect(mockMonitorService.searchEvents).toHaveBeenCalledWith('user-1', query);
  });

  it('rejects invalid date filters with 400 on search and export', async () => {
    const user = { id: 'user-1' } as any;
    const bad = { from: 'not-a-date', page: 1, limit: 25 } as SearchEventsQueryDto;

    expect.assertions(2);
    await expect(controller.searchEvents(user, bad)).rejects.toThrow(
      'Invalid ISO date for "from"',
    );
    await expect(
      controller.exportSearchEventsCsv(
        user,
        { to: '31/12/2026' } as ExportEventsQueryDto,
        createFakeReply(),
      ),
    ).rejects.toThrow('Invalid ISO date for "to"');
  });

  it('streams the CSV export with BOM, headers and correct content disposition', async () => {
    const user = { id: 'user-1' } as any;
    const query = { page: 1, limit: 10000 } as ExportEventsQueryDto;
    const reply = createFakeReply();
    mockMonitorService.streamSearchEventsCsv.mockImplementation(
      async (
        _userId: string,
        _query: unknown,
        onRow: (values: (string | number | null)[]) => Promise<void> | void,
        onEnd: (total: number) => Promise<void> | void,
      ) => {
        await onRow([
          'payment',
          '2026-08-31T12:00:00.000Z',
          '10.5',
          'XLM',
          'GFROM',
          'GTO, Inc',
          'deadbeef',
          '100',
          'watch-1',
          '{"amount":"10.5"}',
        ]);
        await onEnd(1);
      },
    );

    await controller.exportSearchEventsCsv(user, query, reply);

    const headerCalls = (reply.raw.setHeader as jest.Mock).mock.calls;
    expect(headerCalls).toContainEqual([
      'Content-Type',
      'text/csv; charset=utf-8',
    ]);
    expect(headerCalls).toContainEqual([
      'Content-Disposition',
      'attachment; filename="monitor-search.csv"',
    ]);
    // First write is the UTF-8 BOM, second is the CSV header row.
    expect(reply.writes[0]).toBe('\uFEFF');
    expect(reply.writes[1]).toContain('event_type,occurred_at,amount,asset');
    // Commas inside a field must be quoted, not treated as separators.
    expect(reply.writes[2]).toContain('"GTO, Inc"');
    expect(reply.raw.end).toHaveBeenCalled();
  });

  it('never streams rows for a different user (cross-user denial)', async () => {
    const attacker = { id: 'user-2' } as any;
    const query = { page: 1, limit: 25 } as SearchEventsQueryDto;
    const reply = createFakeReply();
    mockMonitorService.streamSearchEventsCsv.mockImplementation(
      async (
        userId: string,
        _query: unknown,
        onRow: (values: (string | number | null)[]) => Promise<void> | void,
        onEnd: (total: number) => Promise<void> | void,
      ) => {
        // The service itself scopes the query to `userId` (covered in
        // monitor-search.spec.ts); here we assert the controller forwards the
        // authenticated caller, never a client-supplied id.
        await onRow(['payment', '2026-08-31T12:00:00.000Z', '1', 'XLM', 'GFROM', 'GTO', 'h', '1', 'watch-1', '{}']);
        await onEnd(1);
        return userId;
      },
    );

    await controller.exportSearchEventsCsv(attacker, query, reply);

    expect(mockMonitorService.streamSearchEventsCsv).toHaveBeenCalledWith(
      'user-2',
      query,
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('enforces the 100-row search limit and 10,000-row export cap via the DTOs', async () => {
    const searchDto = plainToInstance(SearchEventsQueryDto, { limit: 500 });
    const searchViolations = await validate(searchDto as object);
    expect(searchViolations.some((v) => v.property === 'limit')).toBe(true);

    const exportDto = plainToInstance(ExportEventsQueryDto, { limit: 10001 });
    const exportViolations = await validate(exportDto as object);
    expect(exportViolations.some((v) => v.property === 'limit')).toBe(true);

    const okSearch = plainToInstance(SearchEventsQueryDto, { limit: 100 });
    expect(await validate(okSearch as object)).toHaveLength(0);

    const okExport = plainToInstance(ExportEventsQueryDto, { limit: 10000 });
    expect(await validate(okExport as object)).toHaveLength(0);
  });
});
