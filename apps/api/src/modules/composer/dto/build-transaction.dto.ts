import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TimeBoundsDto {
  @ApiProperty({ example: 0, description: 'Minimum unix time (0 = no lower bound)' })
  @IsInt()
  @Min(0)
  minTime: number;

  @ApiProperty({ example: 1893456000, description: 'Maximum unix time' })
  @IsInt()
  @Min(0)
  maxTime: number;
}

export class PreconditionsDto {
  @ApiProperty({
    example: 'time_bounds',
    enum: ['time_bounds', 'ledger_bounds', 'min_sequence'],
  })
  @IsIn(['time_bounds', 'ledger_bounds', 'min_sequence'])
  type: 'time_bounds' | 'ledger_bounds' | 'min_sequence';

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @ValidateIf((o: PreconditionsDto) => o.type === 'time_bounds')
  minTime?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @ValidateIf((o: PreconditionsDto) => o.type === 'time_bounds')
  maxTime?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @ValidateIf((o: PreconditionsDto) => o.type === 'ledger_bounds')
  minLedger?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @ValidateIf((o: PreconditionsDto) => o.type === 'ledger_bounds')
  maxLedger?: number;

  @ApiPropertyOptional({ description: 'Minimum sequence number (string to avoid precision loss)' })
  @IsOptional()
  @Matches(/^\d+$/, { message: 'minSequence must be a non-negative integer string' })
  @ValidateIf((o: PreconditionsDto) => o.type === 'min_sequence')
  minSequence?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @ValidateIf((o: PreconditionsDto) => o.type === 'min_sequence')
  minLedgerAge?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @ValidateIf((o: PreconditionsDto) => o.type === 'min_sequence')
  maxLedgerAhead?: number;
}

export type OperationDto = Record<string, any> & { type: string };

export class BuildTransactionDto {
  @ApiProperty({ description: 'Stellar source account public key (G…)' })
  @IsString()
  sourceAccount: string;

  @ApiPropertyOptional({ example: 'testnet', enum: ['testnet', 'mainnet'] })
  @IsOptional()
  @IsIn(['testnet', 'mainnet'])
  network?: 'testnet' | 'mainnet';

  @ApiPropertyOptional({ description: 'Optional memo text (max 28 bytes)' })
  @IsOptional()
  @IsString()
  memo?: string;

  @ApiPropertyOptional({ description: 'Transaction fee in stroops (defaults to BASE_FEE)' })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'fee must be a positive integer string' })
  fee?: string;

  @ApiPropertyOptional({
    description:
      'Sequence number as a string. Omit to load the next sequence from Horizon.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+$/, { message: 'sequenceNumber must be a non-negative integer string' })
  sequenceNumber?: string;

  @ApiPropertyOptional({
    description:
      'Legacy time bounds. Prefer `preconditions`. Mutually exclusive with preconditions.',
  })
  @IsOptional()
  timeBounds?: TimeBoundsDto;

  @ApiPropertyOptional({
    description:
      'Transaction preconditions (time_bounds, ledger_bounds, min_sequence). Mutually exclusive with timeBounds.',
    type: [PreconditionsDto],
  })
  @IsOptional()
  @IsArray()
  preconditions?: PreconditionsDto[];

  @ApiProperty({ description: 'Ordered array of operations (flattened fields)', isArray: true })
  @IsArray()
  operations: any[];
}
