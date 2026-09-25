import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WebhookService, WebhookHistoryEntry } from './webhook.service';
import { SendWebhookDto } from './dto/send-webhook.dto';
import { WebhookTemplate } from './webhook-templates';
import { WebhookSigningStatus } from './signature';

@ApiTags('webhooks')
@ApiCookieAuth()
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Get('templates')
  @ApiOperation({ summary: 'Get available webhook templates and sample payloads' })
  @ApiResponse({ status: 200, description: 'List of webhook templates' })
  getTemplates(): WebhookTemplate[] {
    return this.webhookService.getTemplates();
  }

  /**
   * Public on purpose: it reports configuration and the wire format only, never
   * a secret, so a receiver can confirm the contract before pointing traffic at
   * this deployment.
   */
  @Get('signing')
  @ApiOperation({
    summary: 'Get outbound webhook signing status and wire format',
  })
  @ApiResponse({ status: 200, description: 'Signing status and signature format' })
  getSigningStatus(): WebhookSigningStatus {
    return this.webhookService.getSigningStatus();
  }

  @Post('templates')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Save or update a webhook template' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  saveTemplate(@Body() template: WebhookTemplate): WebhookTemplate {
    return this.webhookService.saveTemplate(template);
  }

  @Post('send')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Send a webhook to a target endpoint' })
  @ApiResponse({ status: 201, description: 'Webhook sent successfully' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  async sendWebhook(
    @CurrentUser() user: { id: string },
    @Body() dto: SendWebhookDto,
  ): Promise<WebhookHistoryEntry | WebhookHistoryEntry[]> {
    return this.webhookService.sendWebhook(user.id, dto);
  }

  @Get('history')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get recent webhook execution history' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  getHistory(@CurrentUser() user: { id: string }): WebhookHistoryEntry[] {
    return this.webhookService.getHistory(user.id);
  }

  @Post('replay/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Replay a previous webhook from history' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  async replayWebhook(
    @CurrentUser() user: { id: string },
    @Param('id') id: string,
  ): Promise<WebhookHistoryEntry> {
    return this.webhookService.replayWebhook(user.id, id);
  }
}
