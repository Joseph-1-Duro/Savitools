import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, IsUrl, MinLength, IsIn, IsInt, Min, Max } from 'class-validator';

export class SendWebhookDto {
  @ApiProperty({ example: 'https://example.com/webhooks/crowdpay', description: 'Target endpoint URL' })
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
  @MinLength(1)
  endpointUrl!: string;

  @ApiProperty({ example: 'campaign.funded', description: 'Webhook event type' })
  @IsString()
  @MinLength(1)
  eventType!: string;

  @ApiPropertyOptional({ description: 'Custom payload (overrides template). If omitted, the template for eventType is used.' })
  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'HMAC-SHA256 secret, defaulting to WEBHOOK_SIGNING_SECRET. When set, the request carries ' +
      'X-SaviTools-Signature: sha256=<hex> and X-SaviTools-Timestamp: <unix seconds>, where the ' +
      'hex is HMAC-SHA256 over the UTF-8 bytes of `<timestamp>.<body>`.',
  })
  @IsOptional()
  @IsString()
  secret?: string;

  @ApiPropertyOptional({ description: 'HTTP method', enum: ['GET', 'POST', 'PUT', 'PATCH'], default: 'POST' })
  @IsOptional()
  @IsIn(['GET', 'POST', 'PUT', 'PATCH'])
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH';

  @ApiPropertyOptional({ description: 'Custom headers' })
  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Repeat count for load testing', default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  repeatCount?: number;

  @ApiPropertyOptional({ description: 'Interval in milliseconds between repeats', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  repeatIntervalMs?: number;
}
