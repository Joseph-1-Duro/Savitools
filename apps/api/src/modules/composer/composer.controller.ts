import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ComposerService } from './composer.service';
import { TransactionSequenceService } from './transaction-sequence.service';
import { BuildTransactionDto } from './dto/build-transaction.dto';
import { SimulateTransactionDto } from './dto/simulate-transaction.dto';
import { BenchmarkTransactionDto } from './dto/benchmark-transaction.dto';
import { RunTransactionSequenceDto } from './dto/transaction-sequence.dto';

@ApiTags('composer')
@Controller('composer')
export class ComposerController {
  constructor(
    private readonly composerService: ComposerService,
    private readonly transactionSequenceService: TransactionSequenceService,
  ) {}

  @Get('operations')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List supported operation types and their fields' })
  @ApiResponse({ status: 200, description: 'Operation manifest' })
  getOperations() {
    return this.composerService.getOperations();
  }

  @Post('build')
  @ApiOperation({ summary: 'Build an unsigned Stellar transaction XDR' })
  @ApiResponse({ status: 201, description: 'Transaction built successfully' })
  async buildTransaction(@Body() dto: BuildTransactionDto) {
    return this.composerService.buildTransaction(dto);
  }

  @Post('simulate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Simulate a transaction envelope via Horizon' })
  @ApiResponse({ status: 200, description: 'Simulation completed' })
  async simulateTransaction(@Body() dto: SimulateTransactionDto) {
    return this.composerService.simulateTransaction(dto);
  }

  @Post('benchmark')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run sequential and concurrent transaction submission benchmarks' })
  @ApiResponse({ status: 200, description: 'Benchmark completed' })
  async benchmarkTransaction(@Body() dto: BenchmarkTransactionDto) {
    return this.composerService.benchmarkTransaction(dto);
  }

  @Post('sequence/run')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Run a transaction sequence with automatic sequence numbers' })
  @ApiResponse({ status: 200, description: 'Sequence executed' })
  async runTransactionSequence(@Body() dto: RunTransactionSequenceDto) {
    return this.transactionSequenceService.run(dto);
  }

  @Get('sequence')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List transaction sequence runs' })
  @ApiResponse({ status: 200, description: 'Sequence history' })
  async listTransactionSequences() {
    return this.transactionSequenceService.list();
  }
}
