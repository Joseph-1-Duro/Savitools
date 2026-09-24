import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags, ApiResponse } from '@nestjs/swagger';
import { SimulatorService } from './simulator.service';
import { OrderbookService } from './orderbook.service';
import { FindPathsDto } from './dto/find-paths.dto';
import { EstimateDto } from './dto/estimate.dto';
import { SimulateStrictSendDto } from './dto/strict-send.dto';
import { SimulateStrictReceiveDto } from './dto/strict-receive.dto';
import { SimulateFeeQueryDto } from './dto/simulate-fee.dto';
import { OrderbookQueryDto } from './dto/orderbook.dto';
import { TradesQueryDto, OrderQuoteDto } from './dto/trades.dto';

@ApiTags('simulator')
@Controller('simulator')
export class SimulatorController {
  constructor(
    private readonly simulatorService: SimulatorService,
    private readonly orderbookService: OrderbookService,
  ) {}

  @Get('paths')
  @ApiOperation({ summary: 'Find payment paths between two assets' })
  @ApiQuery({ name: 'direction', enum: ['strict_send', 'strict_receive'] })
  @ApiQuery({ name: 'source_asset_type', enum: ['native', 'credit_alphanum4', 'credit_alphanum12'] })
  @ApiQuery({ name: 'source_asset_code', required: false })
  @ApiQuery({ name: 'source_asset_issuer', required: false })
  @ApiQuery({ name: 'amount' })
  @ApiQuery({ name: 'destination_asset_type', enum: ['native', 'credit_alphanum4', 'credit_alphanum12'] })
  @ApiQuery({ name: 'destination_asset_code', required: false })
  @ApiQuery({ name: 'destination_asset_issuer', required: false })
  @ApiQuery({ name: 'network', required: false, enum: ['mainnet', 'testnet'] })
  @ApiResponse({ status: 200, description: 'Payment paths found' })
  @ApiResponse({ status: 400, description: 'Invalid parameters or no paths found' })
  async findPaths(
    @Query() dto: FindPathsDto,
  ) {

    const paths = await this.simulatorService.findPaths(dto);
    return { paths, direction: dto.direction };
  }

  @Post('estimate')
  @ApiOperation({ summary: 'Compute destination_min or send_max for a selected path with slippage' })
  @ApiResponse({ status: 200, description: 'Slippage estimate calculated' })
  @ApiResponse({ status: 400, description: 'Invalid path or amount' })
  async estimateSlippage(@Body() dto: EstimateDto) {
    return this.simulatorService.estimateSlippage(dto);
  }

  @Post('path-send')
  @ApiOperation({ summary: 'Find paths for a strict send payment' })
  @ApiResponse({ status: 200, description: 'Paths found for strict send' })
  @ApiResponse({ status: 400, description: 'Invalid send parameters' })
  simulateStrictSend(@Body() dto: SimulateStrictSendDto) {
    return this.simulatorService.simulateStrictSend(dto);
  }

  @Post('path-receive')
  @ApiOperation({ summary: 'Find paths for a strict receive payment' })
  @ApiResponse({ status: 200, description: 'Paths found for strict receive' })
  @ApiResponse({ status: 400, description: 'Invalid receive parameters' })
  simulateStrictReceive(@Body() dto: SimulateStrictReceiveDto) {
    return this.simulatorService.simulateStrictReceive(dto);
  }

  @Get('fee')
  @ApiOperation({ summary: 'Estimate transaction fee based on current network fee stats' })
  @ApiResponse({ status: 200, description: 'Fee estimate calculated' })
  simulateFee(@Query() query: SimulateFeeQueryDto) {
    const operations = query.operations ?? 1;
    const network = query.network ?? 'testnet';
    return this.simulatorService.simulateFee(operations, network);
  }

  @Get('orderbook')
  @ApiOperation({ summary: 'Get the live DEX order book, spread, and liquidity score for an asset pair' })
  @ApiResponse({ status: 200, description: 'Order book retrieved' })
  @ApiResponse({ status: 400, description: 'Invalid asset or network' })
  getOrderbook(@Query() query: OrderbookQueryDto) {
    return this.orderbookService.getOrderbook(
      query.selling,
      query.buying,
      query.network ?? 'testnet',
    );
  }

  @Get('orderbook/history')
  @ApiOperation({ summary: 'Get the last 60 mid-price snapshots for an asset pair' })
  @ApiResponse({ status: 200, description: 'Mid-price history retrieved' })
  getOrderbookHistory(@Query() query: OrderbookQueryDto) {
    return this.orderbookService.getHistory(
      query.selling,
      query.buying,
      query.network ?? 'testnet',
    );
  }

  @Get('trades')
  @ApiOperation({ summary: 'Get a paginated tape of executed DEX trades for an asset pair' })
  @ApiResponse({ status: 200, description: 'Trade tape retrieved (empty array when no matches)' })
  @ApiResponse({ status: 400, description: 'Invalid filters, asset, network, or Horizon unavailable' })
  getTrades(@Query() query: TradesQueryDto) {
    return this.orderbookService.getTrades(query);
  }

  @Post('orderbook/quote')
  @ApiOperation({ summary: 'Walk the book for a trade size and estimate fills, fees, and price impact' })
  @ApiResponse({ status: 201, description: 'Quote calculated' })
  @ApiResponse({ status: 400, description: 'Invalid amount, asset pair, or network' })
  getQuote(@Body() dto: OrderQuoteDto) {
    return this.orderbookService.getQuote(dto);
  }
}
