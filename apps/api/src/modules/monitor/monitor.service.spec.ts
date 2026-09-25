import { Repository } from 'typeorm';
import { MonitorWebhook } from './entities/monitor-webhook.entity';
import { AlertEvent } from './entities/alert-event.entity';
import { WatchEvent } from './entities/watch-event.entity';
import { Watch } from './entities/watch.entity';
import { MonitorQueueService } from './monitor-queue.service';
import { MonitorService } from './monitor.service';
import { StreamManager } from './stream-manager.service';
import { WatchRegistry } from './watch-registry.service';

describe('MonitorService', () => {
  it('closes the stream after deleting the last watch for a public key', async () => {
    const watch = {
      id: 'watch-one',
      userId: 'user-one',
      network: 'testnet',
      type: 'account',
      publicKey: 'GACCOUNT',
    } as Watch;
    const watchRepository = {
      findOne: jest.fn().mockResolvedValue(watch),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
    } as unknown as Repository<Watch>;
    const registry = {
      remove: jest.fn().mockReturnValue(true),
      keyFor: jest.fn().mockReturnValue('testnet:account:GACCOUNT'),
    } as unknown as WatchRegistry;
    const streamManager = {
      stop: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamManager;
    const service = new MonitorService(
      watchRepository,
      {} as Repository<WatchEvent>,
      {} as Repository<AlertEvent>,
      {} as Repository<MonitorWebhook>,
      registry,
      streamManager,
      {} as MonitorQueueService,
      {} as any,
    );

    await service.deleteWatch('user-one', 'watch-one');

    expect(watchRepository.delete).toHaveBeenCalledWith('watch-one');
    expect(registry.remove).toHaveBeenCalledWith(watch);
    expect(streamManager.stop).toHaveBeenCalledWith('testnet:account:GACCOUNT');
  });

  it('starts a shared watch from the existing persisted checkpoint', async () => {
    const existing = {
      transactionCursor: '100',
      paymentCursor: '200',
      contractCursor: null,
      cursorLedger: '300',
      streamMode: 'sse',
      status: 'streaming',
      lastEventAt: new Date('2026-01-01T00:00:00.000Z'),
      lastError: null,
    } as Watch;
    const watchRepository = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ id: 'watch-two', ...value })),
    } as unknown as Repository<Watch>;
    const registry = {
      get: jest.fn().mockReturnValue([existing]),
      add: jest.fn(),
      keyFor: jest.fn().mockReturnValue('testnet:account:GAAAAAAAA'),
    } as unknown as WatchRegistry;
    const streamManager = {
      start: jest.fn().mockResolvedValue(undefined),
    } as unknown as StreamManager;
    const service = new MonitorService(
      watchRepository,
      {} as Repository<WatchEvent>,
      {} as Repository<AlertEvent>,
      {} as Repository<MonitorWebhook>,
      registry,
      streamManager,
      {} as MonitorQueueService,
      {} as any,
    );

    const created = await service.createWatch('user-two', {
      publicKey: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      label: 'Shared account',
      eventTypes: ['payment'],
      network: 'testnet',
      alertRules: [],
    });

    expect(created.transactionCursor).toBe('100');
    expect(created.paymentCursor).toBe('200');
    expect(created.cursorLedger).toBe('300');
    expect(created.streamMode).toBe('sse');
    expect(created.status).toBe('streaming');
    expect(created.lastEventAt).toEqual(existing.lastEventAt);
    expect(registry.add).toHaveBeenCalledWith(created);
    expect(streamManager.start).toHaveBeenCalledWith(
      'testnet:account:GAAAAAAAA',
    );
  });
});
