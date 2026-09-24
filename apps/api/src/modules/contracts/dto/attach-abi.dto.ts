import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Maximum accepted ABI/interface document size in bytes (serialized JSON). */
export const ABI_MAX_BYTES = 512 * 1024;

export type AbiNetwork = 'testnet' | 'mainnet';

export interface AbiMethodArg {
  name: string;
  type: string;
}

export interface AbiEventTopic {
  name: string;
  indexed: boolean;
}

export interface AbiMethod {
  name: string;
  arguments: AbiMethodArg[];
  returnType: string;
}

export interface AbiEvent {
  name: string;
  arguments: AbiMethodArg[];
  topics: AbiEventTopic[];
}

export class AttachAbiDto {
  @ApiProperty({
    description:
      'Validated contract ABI / interface JSON document (methods + events)',
  })
  @IsObject()
  @IsArray()
  schema!: Record<string, unknown> & { methods?: unknown[]; events?: unknown[] };

  @ApiPropertyOptional({ enum: ['testnet', 'mainnet'], default: 'testnet' })
  @IsOptional()
  @IsIn(['testnet', 'mainnet'])
  network?: 'testnet' | 'mainnet';

  @ApiPropertyOptional({ description: 'Optional display name for the interface' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: 'WASM identifier (wasmId) to bind the interface to' })
  @IsOptional()
  @IsString()
  wasmId?: string;
}
