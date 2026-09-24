import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBase64,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class PasskeyRenameDto {
  @ApiProperty({ description: 'New human-readable label', example: 'MacBook Touch ID' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;
}

export class PasskeyReauthDto {
  @ApiProperty({ description: 'Password (used only to mint a short-lived reauthentication grant)' })
  @IsString()
  @MinLength(1)
  password!: string;
}

export class PasskeyRegistrationVerifyDto {
  @ApiProperty({ description: 'Short-lived reauthentication grant from /auth/reauthenticate' })
  @IsString()
  @MinLength(1)
  reauthToken!: string;

  @ApiProperty({ description: 'Credential label' })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  name!: string;

  @ApiProperty({
    description: 'Attestation response from the WebAuthn API (navigator.credentials.create)',
  })
  @IsObject()
  registrationResponse!: unknown;

  @ApiPropertyOptional({ description: 'Authenticator transports declared at creation' })
  @IsOptional()
  @IsArray()
  transports?: string[];
}

export class PasskeyLoginVerifyDto {
  @ApiProperty({
    description: 'Assertion response from the WebAuthn API (navigator.credentials.get)',
  })
  @IsObject()
  assertionResponse!: unknown;
}
