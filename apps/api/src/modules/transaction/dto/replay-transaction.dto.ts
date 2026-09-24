import { IsIn, IsOptional, IsString, IsArray, ValidateNested, Equals } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TimeBoundsDto {
  @ApiProperty({ example: 1700000000 })
  minTime: number;

  @ApiProperty({ example: 1800000000 })
  maxTime: number;
}

export class TransactionModificationsDto {
  @ApiPropertyOptional({ description: 'New source account public key' })
  @IsOptional()
  @IsString()
  sourceAccount?: string;

  @ApiPropertyOptional({ description: 'New memo text' })
  @IsOptional()
  @IsString()
  memo?: string;

  @ApiPropertyOptional({ description: 'New time bounds' })
  @IsOptional()
  @ValidateNested()
  @Type(() => TimeBoundsDto)
  timeBounds?: TimeBoundsDto;

  @ApiPropertyOptional({ description: 'New operations array (raw or structured)' })
  @IsOptional()
  @IsArray()
  operations?: any[];
}

export class ReplayTransactionDto {
  @ApiProperty({ description: 'Historical transaction hash from Horizon' })
  @IsString()
  transactionHash: string;

  @ApiPropertyOptional({ example: 'testnet', enum: ['testnet', 'mainnet'] })
  @IsOptional()
  @IsIn(['testnet', 'mainnet'])
  network?: 'testnet' | 'mainnet';

  @ApiPropertyOptional({ description: 'Parameter modifications to apply' })
  @IsOptional()
  @ValidateNested()
  @Type(() => TransactionModificationsDto)
  modifications?: TransactionModificationsDto;

  @ApiPropertyOptional({
    description:
      'Deprecated: server-side submission is no longer supported. Sign the returned unsigned XDR in the browser and submit it via the Composer sign/submit flow instead.',
    deprecated: true,
  })
  @IsOptional()
  @Equals(undefined, {
    message:
      'submit is no longer supported by this endpoint. Sign modifiedXdr in the browser (see Composer sign/submit flow) and submit it separately.',
  })
  submit?: never;

  @ApiPropertyOptional({
    description:
      'Deprecated: secret keys must never be sent to the server. Sign the returned unsigned XDR in the browser instead.',
    deprecated: true,
  })
  @IsOptional()
  @Equals(undefined, {
    message:
      'secretKey is no longer accepted by this endpoint. Sign modifiedXdr in the browser (see Composer sign/submit flow) instead of sending a secret key to the server.',
  })
  secretKey?: never;
}
