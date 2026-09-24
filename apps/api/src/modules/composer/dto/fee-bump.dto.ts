import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class FeeBumpDto {
  @ApiProperty({
    description: 'Base64 XDR of an unsigned classic inner transaction envelope',
    example: 'AAAAAgAAA...',
  })
  @IsString()
  innerXdr: string;

  @ApiProperty({ description: 'Fee-source account public key (G…)', example: 'G…' })
  @IsString()
  feeSource: string;

  @ApiProperty({
    description: 'Fee per operation in stroops for the outer envelope (stroops)',
    example: '5000',
  })
  @IsString()
  @Matches(/^\d+$/, { message: 'baseFee must be a non-negative integer string' })
  baseFee: string;

  @ApiPropertyOptional({ example: 'testnet', enum: ['testnet', 'mainnet'] })
  @IsOptional()
  @IsIn(['testnet', 'mainnet'])
  network?: 'testnet' | 'mainnet';
}
