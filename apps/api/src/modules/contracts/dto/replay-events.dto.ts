import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One replay call fans out to one POST per event, so the batch is capped to
 * bound the outbound amplification a single request can cause.
 */
export const REPLAY_MAX_EVENTS = 200;

export class ReplayEventsDto {
  @ApiProperty({ description: 'Destination endpoint. Validated against the SSRF guard.' })
  @IsString()
  webhookUrl!: string;

  @ApiPropertyOptional({
    description:
      'HMAC-SHA256 secret, defaulting to WEBHOOK_SIGNING_SECRET. When set, each POST carries ' +
      'X-SaviTools-Signature: sha256=<hex> and X-SaviTools-Timestamp: <unix seconds>, where the ' +
      'hex is HMAC-SHA256 over the UTF-8 bytes of `<timestamp>.<body>`.',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  secret?: string;

  @ApiProperty({
    description: 'Decoded events to replay, in order.',
    type: 'array',
    items: { type: 'object' },
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(REPLAY_MAX_EVENTS)
  events!: unknown[];
}
