jest.mock('redis', () => {
  const mockRedisClient = {
    connect: jest.fn(),
    quit: jest.fn(),
    lPush: jest.fn(),
    lTrim: jest.fn(),
    lRange: jest.fn(),
    zAdd: jest.fn(),
    zCard: jest.fn().mockResolvedValue(0),
    zRemRangeByRank: jest.fn(),
    zRemRangeByScore: jest.fn(),
    zRange: jest.fn().mockResolvedValue([]),
    on: jest.fn(),
  };
  return {
    createClient: jest.fn(() => mockRedisClient),
    __mockRedisClient: mockRedisClient,
  };
});

import { BadRequestException } from '@nestjs/common';
import { OrderbookService } from './orderbook.service';
const { __mockRedisClient: mockRedisClient } = require('redis');

function horizonOrderBookResponse() {
  return {
    bids: [
      { price: '0.1000000', amount: '100.0000000' },
      { price: '0.0990000', amount: '200.0000000' },
      { price: '0.0980000', amount: '50.0000000' },
    ],
    asks: [
      { price: '0.1020000', amount: '150.0000000' },
      { price: '0.1030000', amount: '300.0000000' },
      { price: '0.1040000', amount: '20.0000000' },
    ],
  };
}

describe('OrderbookService', () => {
  let service: OrderbookService;

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    service = new OrderbookService({ get: jest.fn(() => 'redis://localhost:6379') } as any);
  });

  afterEach(() => {
    if ((service as any).pollInterval) {
      clearInterval((service as any).pollInterval);
    }
  });

  describe('getOrderbook', () => {
    it('computes spread, mid price, and cumulative levels from Horizon', async () => {
      (service as any).redisClient = mockRedisClient;
      mockRedisClient.zAdd.mockResolvedValue(undefined);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => horizonOrderBookResponse(),
      });

      const result = await service.getOrderbook(
        'XLM',
        'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ',
        'testnet',
      );

      expect(result.bestBid).toBe('0.1000000');
      expect(result.bestAsk).toBe('0.1020000');
      expect(result.midPrice).toBe('0.1010000');
      expect(result.spread).toBe('0.0020000');

      // spreadBps = (0.102 - 0.100) / 0.101 * 10000
      const expectedBps = Math.round(((0.102 - 0.1) / 0.101) * 10000 * 100) / 100;
      expect(result.spreadBps).toBeCloseTo(expectedBps, 2);

      expect(result.bids).toHaveLength(3);
      expect(result.bids[0].cumulativeAmount).toBe('100.0000000');
      expect(result.bids[1].cumulativeAmount).toBe('300.0000000');
      expect(result.bids[2].cumulativeAmount).toBe('350.0000000');
      expect(result.bids[2].cumulativePercent).toBe(100);

      expect(result.asks).toHaveLength(3);
      expect(result.asks[0].cumulativeAmount).toBe('150.0000000');
      expect(result.asks[1].cumulativeAmount).toBe('450.0000000');
      expect(result.asks[2].cumulativeAmount).toBe('470.0000000');

      expect(mockRedisClient.zAdd).toHaveBeenCalledWith(
        'orderbook:active_pairs:testnet',
        [
          expect.objectContaining({
            value: expect.stringContaining('native|USDC'),
          }),
        ],
      );
    });

    it('gives a low liquidity score for a thin book', async () => {
      (service as any).redisClient = mockRedisClient;
      mockRedisClient.zAdd.mockResolvedValue(undefined);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          bids: [{ price: '0.10', amount: '1' }],
          asks: [
            { price: '0.11', amount: '1' },
            { price: '5.00', amount: '10000' },
          ],
        }),
      });

      const result = await service.getOrderbook('XLM', 'USDC:ISSUER', 'testnet');
      expect(result.liquidityScore).toBeLessThan(20);
    });

    it('gives a high liquidity score for a deep, tight book', async () => {
      (service as any).redisClient = mockRedisClient;
      mockRedisClient.zAdd.mockResolvedValue(undefined);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          bids: [
            { price: '0.100', amount: '1000' },
            { price: '0.0995', amount: '1000' },
          ],
          asks: [
            { price: '0.101', amount: '1000' },
            { price: '0.1015', amount: '1000' },
          ],
        }),
      });

      const result = await service.getOrderbook('XLM', 'USDC:ISSUER', 'testnet');
      expect(result.liquidityScore).toBeGreaterThan(70);
    });

    it('throws for an invalid asset string', async () => {
      (service as any).redisClient = mockRedisClient;
      await expect(service.getOrderbook('NOTVALID', 'XLM', 'testnet')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getHistory', () => {
    it('returns reversed mid-price snapshots from Redis', async () => {
      (service as any).redisClient = mockRedisClient;
      const entries = [
        JSON.stringify({ timestamp: 3, midPrice: '0.12' }),
        JSON.stringify({ timestamp: 2, midPrice: '0.11' }),
        JSON.stringify({ timestamp: 1, midPrice: '0.10' }),
      ];
      mockRedisClient.lRange.mockResolvedValue(entries);

      const result = await service.getHistory('XLM', 'USDC:ISSUER', 'testnet');

      expect(result).toHaveLength(3);
      expect(result[0].timestamp).toBe(1);
      expect(result[2].timestamp).toBe(3);
    });

    it('returns empty array on Redis error', async () => {
      (service as any).redisClient = mockRedisClient;
      mockRedisClient.lRange.mockRejectedValue(new Error('Redis down'));

      const result = await service.getHistory('XLM', 'USDC:ISSUER', 'testnet');
      expect(result).toEqual([]);
    });

    it('returns empty array when Redis is not connected', async () => {
      (service as any).redisClient = undefined;
      const result = await service.getHistory('XLM', 'USDC:ISSUER', 'testnet');
      expect(result).toEqual([]);
    });
  });

  describe('onModuleInit / onModuleDestroy', () => {
    it('connects to Redis, seeds the default pair, and polls', async () => {
      mockRedisClient.connect.mockResolvedValue(undefined);
      mockRedisClient.zAdd.mockResolvedValue(undefined);
      mockRedisClient.zCard.mockResolvedValue(1);
      mockRedisClient.zRange.mockResolvedValue([
        'XLM|USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHT3VM35KCEIWI6VH5XY4O2Y5JV3CJQ',
      ]);
      mockRedisClient.lPush.mockResolvedValue(undefined);
      mockRedisClient.lTrim.mockResolvedValue(undefined);
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => horizonOrderBookResponse(),
      });

      await service.onModuleInit();

      expect(mockRedisClient.connect).toHaveBeenCalled();
      expect(mockRedisClient.zAdd).toHaveBeenCalled();
      expect(mockRedisClient.lPush).toHaveBeenCalled();
    });

    it('clears interval and quits Redis on destroy', async () => {
      (service as any).redisClient = mockRedisClient;
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      (service as any).pollInterval = setInterval(() => {}, 60000);

      await service.onModuleDestroy();

      expect(clearIntervalSpy).toHaveBeenCalled();
      expect(mockRedisClient.quit).toHaveBeenCalled();
    });
  });
});
