import { Module } from '@nestjs/common';
import { StellarTestnetService } from './stellar-testnet.service';

/**
 * Shared Stellar testnet operations.
 *
 * Imported by the wallet and sandbox modules so a single implementation backs
 * both pages.
 */
@Module({
  providers: [StellarTestnetService],
  exports: [StellarTestnetService],
})
export class StellarTestnetModule {}
