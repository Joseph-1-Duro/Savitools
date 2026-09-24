import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type TransferSep = '6' | '24' | '31';

export class LinkPreviewQueryDto {
  @ApiProperty({ description: 'Anchor domain with a stellar.toml', example: 'stellar.org' })
  @IsString()
  @IsNotEmpty()
  domain!: string;

  @ApiProperty({ enum: ['6', '24', '31'], description: 'SEP the request link is for' })
  @IsIn(['6', '24', '31'])
  @Type(() => String)
  sep!: TransferSep;

  @ApiProperty({
    description: 'Asset code supported by the anchor (must appear in stellar.toml CURRENCIES)',
    example: 'USDC',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,11})$/, {
    message: 'asset must be a 1-12 character alphanumeric code',
  })
  asset!: string;

  @ApiProperty({
    description:
      'Amount as a decimal string; passed through verbatim with no floating-point conversion',
    example: '100.50',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+(\.\d+)?$/, {
    message: 'amount must be a non-negative decimal string (e.g. "100.50")',
  })
  amount!: string;

  @ApiPropertyOptional({ description: 'Optional memo to attach to the request' })
  @IsOptional()
  @IsString()
  memo?: string;

  @ApiPropertyOptional({ description: 'Callback URL for SEP-6 and SEP-24 flows' })
  @IsOptional()
  @IsString()
  callback?: string;

  @ApiPropertyOptional({
    description: 'Stellar account (G…) making the request',
    example: 'GDJ47UQJNT6UOMV3CLNZ43XGDKOUM3UHV7V3FF3W4KMIRRNICNSS2N2H',
  })
  @IsOptional()
  @IsString()
  account?: string;
}
