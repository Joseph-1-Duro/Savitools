import { Repository } from 'typeorm';
import { MonitorWebhook } from './entities/monitor-webhook.entity';
import { AlertEvent } from './entities/alert-event.entity';
import { WatchEvent } from './entities/watch-event.entity';
import { Watch } from './entities/watch.entity';
import { MonitorQueueService } from './monitor-queue.service';
import { MonitorService } from './monitor.service';
import { StreamManager } from './stream-manager.service';
import { WatchRegistry } from './watch-registry.service';
import { EXPORT_MAX_ROWS, SearchEventsQueryDto } from './dto/search-events.dto';

function makeEvent(overrides: Partial<WatchEvent> = {}): WatchEvent {
  return {
    id: 'event-1',
    watchId: 'watch-1',
    pagingToken: '100',
    source: 'payment',
    eventType: 'payment',
    payload: {
      amount: '10.5',
      asset_type: 'native',
      from: 'GFROM',
      to: 'GTO',
      transaction_hash: 'deadbeef',
    },
    occurredAt: new Date('2026-08-31T12:00:00.000Z'),
    createdAt: new Date('2026-08-31T12:00:00.000Z'),
    ...overrides,
  } as WatchEvent;
}

function fakeQueryBuilder(events: WatchEvent[]) {
  let skip = 0;
  let take = events.length;
  const qb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn((value: number) => {
      skip = value;
      return qb;
    }),
    take: jest.fn((value: number) => {
      take = value;
      return qb;
    }),
    getManyAndCount: jest.fn().mockImplementation(() => {
      const page = events.slice(skip, skip + take);
      return Promise.resolve([page, events.length]);
    }),
  };
  return qb;
}

function makeService(watchEvents: WatchEvent[]) {
  const watchEventRepository = {
    createQueryBuilder: jest.fn().mockReturnValue(fakeQueryBuilder(watchEvents)),
  } as unknown as Repository<WatchEvent>;
  return {
    service: new MonitorService(
      {} as Repository<Watch>,
      watchEventRepository,
      {} as Repository<AlertEvent>,
      {} as Repository<MonitorWebhook>,
      {} as WatchRegistry,
      {} as StreamManager,
      {} as MonitorQueueService,
      {} as any,
    ),
  };
}

describe('MonitorService search & CSV export', () => {
  it('filters events by the current user and returns a page', async () => {
    const { service } = makeService([makeEvent()]);
    const result = await service.searchEvents('user-1', {
      watchId: 'watch-1',
      eventType: 'payment',
      page: 1,
      limit: 25,
    } as SearchEventsQueryDto);

    expect(result.total).toBe(1);
    expect(result.items[0].id).toBe('event-1');
  });

  it('streams CSV rows in chunks and ends with a total', async () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        id: `event-${i}`,
        pagingToken: String(100 + i),
        payload: {
          amount: String(i + 1),
          asset_type: 'native',
          from: 'GFROM',
          to: 'GTO',
          transaction_hash: 'deadbeef',
        },
      }),
    );
    const { service } = makeService(events);

    const rows: unknown[][] = [];
    let total = -1;
    await service.streamSearchEventsCsv(
      'user-1',
      { page: 1, limit: EXPORT_MAX_ROWS } as SearchEventsQueryDto,
      (values) => {
        rows.push(values);
      },
      (count) => {
        total = count;
      },
    );

    expect(total).toBe(5);
    expect(rows).toHaveLength(5);
    expect(rows[0][0]).toBe('payment'); // event_type
    expect(rows[0][1]).toBe('2026-08-31T12:00:00.000Z'); // occurred_at
    expect(rows[0][2]).toBe('1'); // amount
    expect(rows[0][3]).toBe('XLM'); // native asset → XLM
    expect(rows[0][4]).toBe('GFROM');
    expect(rows[0][5]).toBe('GTO');
    expect(rows[0][6]).toBe('deadbeef'); // transaction hash
  });

  it('maps non-native assets to their asset code', async () => {
    const { service } = makeService([
      makeEvent({ payload: { amount: '1', asset_code: 'USDC', asset_type: 'credit_alphanum4' } }),
    ]);
    const rows: unknown[][] = [];
    await service.streamSearchEventsCsv(
      'user-1',
      { page: 1, limit: 100 } as SearchEventsQueryDto,
      (values) => {
        rows.push(values);
      },
      () => undefined,
    );
    expect(rows[0][3]).toBe('USDC');
  });

  it('never exports more than the max row limit', async () => {
    const { service } = makeService([makeEvent()]);
    // Even if the underlying query returned more than the cap (unlikely, since
    // pagination is applied), the loop stops at EXPORT_MAX_ROWS.
    const rows: unknown[][] = [];
    let total = -1;
    await service.streamSearchEventsCsv(
      'user-1',
      { page: 1, limit: EXPORT_MAX_ROWS + 5000 } as SearchEventsQueryDto,
      (values) => {
        rows.push(values);
      },
      (count) => {
        total = count;
      },
    );
    expect(total).toBeLessThanOrEqual(EXPORT_MAX_ROWS);
    expect(rows.length).toBeLessThanOrEqual(EXPORT_MAX_ROWS);
  });

  it('respects a smaller explicit limit', async () => {
    const events = Array.from({ length: 3 }, (_, i) =>
      makeEvent({ id: `event-${i}` }),
    );
    const { service } = makeService(events);
    const rows: unknown[][] = [];
    await service.streamSearchEventsCsv(
      'user-1',
      { page: 1, limit: 2 } as SearchEventsQueryDto,
      (values) => {
        rows.push(values);
      },
      () => undefined,
    );
    expect(rows).toHaveLength(2);
  });
});
