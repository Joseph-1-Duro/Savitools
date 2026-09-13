import { Module } from '@nestjs/common';
import { StellarTestnetModule } from '../stellar/stellar-testnet.module';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

@Module({
  imports: [StellarTestnetModule],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
