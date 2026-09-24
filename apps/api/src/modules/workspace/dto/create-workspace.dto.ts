import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateWorkspaceDTO {
  @ApiProperty({ example: 'My payment flow', description: 'Workspace display name' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;

  @ApiProperty({ type: 'object', additionalProperties: true, description: 'Composer state payload' })
  @IsObject()
  data: Record<string, unknown>;
}
