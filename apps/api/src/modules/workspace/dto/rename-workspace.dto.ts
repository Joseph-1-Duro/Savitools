import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RenameWorkspaceDTO {
  @ApiProperty({ example: 'Renamed workspace', description: 'New workspace display name' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name: string;
}
