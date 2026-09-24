import { Type } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TradesQueryDto {
  @ApiProperty({ example: 'XLM', description: 'Base asset of the pair (XLM or CODE:ISSUER)' })
  @IsString()
  selling: string;

  @ApiProperty({
    example: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    description: 'Counter asset of the pair (XLM or CODE:ISSUER)',
  })
  @IsString()
  buying: string;

  @ApiPropertyOptional({ example: 'testnet', enum: ['testnet', 'mainnet'] })
  @IsOptional()
  @IsIn(['testnet', 'mainnet'])
  network?: 'testnet' | 'mainnet' = 'testnet';

  @ApiPropertyOptional({ example: 50, description: 'Page size (1-200)' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  limit?: number = 50;

  @ApiPropertyOptional({ description: 'Horizon paging token to resume after' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ example: 'desc', enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc' = 'desc';

  @ApiPropertyOptional({
    description: "Side relative to the pair's selling asset: 'sell' = base was sold",
    enum: ['buy', 'sell'],
  })
  @IsOptional()
  @IsIn(['buy', 'sell'])
  side?: 'buy' | 'sell';

  @ApiPropertyOptional({ description: 'Only trades where this account is buyer or seller (G…)' })
  @IsOptional()
  @IsString()
  account?: string;

  @ApiPropertyOptional({ description: 'Only trades at or after this unix time (seconds)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  startTime?: number;

  @ApiPropertyOptional({ description: 'Only trades at or before this unix time (seconds)' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  endTime?: number;
}

export class OrderQuoteDto {
  @ApiProperty({ example: 'XLM', description: "Asset being traded (pair's selling asset)" })
  @IsString()
  selling: string;

  @ApiProperty({
    example: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    description: 'Quote asset (pair\'s buying asset)',
  })
  @IsString()
  buying: string;

  @ApiProperty({
    enum: ['buy', 'sell'],
    description: "Direction: 'buy' sells quote for base (walks asks), 'sell' sells base (walks bids)",
  })
  @IsIn(['buy', 'sell'])
  side: 'buy' | 'sell';

  @ApiProperty({
    example: '100.5',
    description: 'Amount of the selling asset to trade (positive, max 7 decimal places)',
  })
  @IsString()
  @Matches(/^\d+(\.\d{1,7})?$/, {
    message: 'amount must be a positive decimal with at most 7 fractional digits',
  })
  amount: string;

  @ApiPropertyOptional({ example: 'testnet', enum: ['testnet', 'mainnet'] })
  @IsOptional()
  @IsIn(['testnet', 'mainnet'])
  network?: 'testnet' | 'mainnet' = 'testnet';
}
