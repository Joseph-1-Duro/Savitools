import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Password reset token from the email link' })
  @IsString()
  @IsNotEmpty()
  token!: string;

  @ApiProperty({
    example: 'NewSecurePassword123',
    minLength: 8,
    description: 'Password must be at least 8 characters',
  })
  @IsString()
  @MinLength(8)
  password!: string;
}
