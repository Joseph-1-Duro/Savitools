import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class FluxaDto {
  @ApiProperty({ description: 'Fluxa API key used to link accounts' })
  @IsString()
  @MinLength(1)
  apiKey!: string;

  @ApiPropertyOptional({
    description:
      'Explicit re-confirmation required to attach a new Fluxa tenant to an existing account',
  })
  @IsOptional()
  @IsBoolean()
  confirmLink?: boolean;
}
