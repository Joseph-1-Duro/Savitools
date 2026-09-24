import { SimulatorController } from './simulator.controller';
import { SimulatorService } from './simulator.service';
import { OrderbookService } from './orderbook.service';
import { FindPathsDto, Direction, AssetType } from './dto/find-paths.dto';
import { TradesQueryDto, OrderQuoteDto } from './dto/trades.dto';

describe('SimulatorController', () => {
  it('passes the complete DTO to the service without manual casting or defaults', async () => {
    const service = { findPaths: jest.fn().mockResolvedValue([]) } as unknown as SimulatorService;
    const controller = new SimulatorController(service, {} as OrderbookService);
    const dto: FindPathsDto = {
      direction: Direction.STRICT_SEND,
      source_asset_type: AssetType.NATIVE,
      amount: '1.5',
      destination_asset_type: AssetType.NATIVE,
      network: 'testnet',
    };

    await controller.findPaths(dto);

    expect(service.findPaths).toHaveBeenCalledWith(dto);
  });

  it('delegates the trades query to OrderbookService', async () => {
    const orderbook = {
      getTrades: jest.fn().mockResolvedValue({ trades: [], nextCursor: null }),
    } as unknown as OrderbookService;
    const controller = new SimulatorController({} as SimulatorService, orderbook);
    const query: TradesQueryDto = {
      selling: 'XLM',
      buying: 'USDC:ISSUER',
      network: 'mainnet',
      limit: 20,
      cursor: 'abc',
      order: 'asc',
      side: 'buy',
      account: 'GACCT',
      startTime: 1,
      endTime: 2,
    };

    await controller.getTrades(query);

    expect(orderbook.getTrades).toHaveBeenCalledWith(query);
  });

  it('delegates the quote body to OrderbookService', async () => {
    const orderbook = {
      getQuote: jest.fn().mockResolvedValue({ status: 'filled' }),
    } as unknown as OrderbookService;
    const controller = new SimulatorController({} as SimulatorService, orderbook);
    const dto: OrderQuoteDto = {
      selling: 'XLM',
      buying: 'USDC:ISSUER',
      side: 'buy',
      amount: '10',
      network: 'testnet',
    };

    await controller.getQuote(dto);

    expect(orderbook.getQuote).toHaveBeenCalledWith(dto);
  });
});
