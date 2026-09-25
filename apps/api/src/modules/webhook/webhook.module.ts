import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';

// ConfigModule is global, so WebhookService's optional ConfigService resolves
// WEBHOOK_SIGNING_SECRET without a per-module import.
@Module({
  imports: [AuthModule],
  controllers: [WebhookController],
  providers: [WebhookService],
  exports: [WebhookService],
})
export class WebhookModule {}
