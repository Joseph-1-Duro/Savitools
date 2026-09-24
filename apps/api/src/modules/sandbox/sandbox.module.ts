import { Module } from '@nestjs/common';
import { StellarTestnetModule } from '../stellar/stellar-testnet.module';
import { SandboxController } from './sandbox.controller';
import { SandboxService } from './sandbox.service';

@Module({
  imports: [StellarTestnetModule],
  controllers: [SandboxController],
  providers: [SandboxService],
  exports: [SandboxService],
})
export class SandboxModule {}
