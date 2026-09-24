import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createClient } from 'redis';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ConnectedAccount } from './entities/connected-account.entity';
import { PasskeyCredential } from './entities/passkey.entity';
import { RefreshToken } from './entities/refresh-token.entity';
import { User } from './entities/user.entity';
import { VaultKey } from './entities/vault-key.entity';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from './guards/optional-jwt-auth.guard';
import { VaultController } from './vault.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, RefreshToken, ConnectedAccount, VaultKey, PasskeyCredential]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [AuthController, VaultController],
  providers: [
    AuthService,
    JwtAuthGuard,
    OptionalJwtAuthGuard,
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const redisUrl = config.get<string>('REDIS_URL', 'redis://localhost:6379');
        const client = createClient({ url: redisUrl });
        client.on('error', (err: unknown) => {
          // Non-fatal: OAuth nonce storage will degrade gracefully
          console.warn('[redis] Connection error:', err);
        });
        await client.connect();
        return client;
      },
    },
  ],
  exports: [AuthService, JwtAuthGuard, OptionalJwtAuthGuard, JwtModule, 'REDIS_CLIENT'],
})
export class AuthModule {}
