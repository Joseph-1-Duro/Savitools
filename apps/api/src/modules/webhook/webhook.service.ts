import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SendWebhookDto } from './dto/send-webhook.dto';
import { WEBHOOK_TEMPLATES, WebhookTemplate } from './webhook-templates';
import { assertSafeWebhookDestination, MAX_WEBHOOK_REDIRECTS } from './ssrf-guard';
import * as crypto from 'crypto';

export interface WebhookHistoryEntry {
  id: string;
  timestamp: number;
  endpointUrl: string;
  eventType: string;
  method: string;
  requestHeaders: Record<string, string>;
  payload: Record<string, unknown>;
  responseStatus: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string;
  latencyMs: number;
  error?: string;
  repeatIndex?: number;
}

export const OUTBOUND_TIMEOUT_MS = 10_000;
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
export const MAX_RESPONSE_BODY_BYTES = 64 * 1024;
export const MAX_HISTORY_PER_USER = 50;
export const MAX_HISTORY_USERS = 1_000;
export const REDACTED = '[REDACTED]';

const SECRET_HEADER_PATTERN =
  /authorization|cookie|signature|secret|token|key|password|credential/i;

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    redacted[key] = SECRET_HEADER_PATTERN.test(key) ? REDACTED : value;
  }
  return redacted;
}

async function readBodyWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) {
    return { text: '', truncated: false };
  }

  const decoder = new TextDecoder();
  let received = 0;
  let truncated = false;
  let text = '';
  const reader = stream.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        truncated = true;
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    if (!truncated) {
      text += decoder.decode();
    }
  } finally {
    try {
      await stream.cancel();
    } catch {
      // stream already closed
    }
  }

  return { text, truncated };
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private historyByUser = new Map<string, WebhookHistoryEntry[]>();
  private templates: WebhookTemplate[] = [...WEBHOOK_TEMPLATES];

  getTemplates(): WebhookTemplate[] {
    return this.templates;
  }

  saveTemplate(template: WebhookTemplate): WebhookTemplate {
    const existingIndex = this.templates.findIndex(
      (t) => t.provider === template.provider && t.eventType === template.eventType,
    );
    if (existingIndex >= 0) {
      this.templates[existingIndex] = template;
    } else {
      this.templates.push(template);
    }
    return template;
  }

  private recordHistory(userId: string, entry: WebhookHistoryEntry): void {
    let entries = this.historyByUser.get(userId);
    if (!entries) {
      entries = [];
      this.historyByUser.set(userId, entries);
    }

    entries.unshift(entry);
    if (entries.length > MAX_HISTORY_PER_USER) {
      entries.pop();
    }

    if (this.historyByUser.size > MAX_HISTORY_USERS) {
      const oldestUser = this.historyByUser.keys().next().value;
      if (oldestUser !== undefined) {
        this.historyByUser.delete(oldestUser);
      }
    }
  }

  private async performRequest(
    method: string,
    initialUrl: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ status: number | null; headers: Record<string, string>; body: string; truncated: boolean }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);

    try {
      let currentUrl = new URL(initialUrl);
      await assertSafeWebhookDestination(currentUrl);

      let response: Response;
      let redirects = 0;

      for (;;) {
        response = await fetch(currentUrl, {
          method,
          headers,
          body: method !== 'GET' ? body : undefined,
          redirect: 'manual',
          signal: controller.signal,
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || redirects >= MAX_WEBHOOK_REDIRECTS) {
            break;
          }
          redirects += 1;
          void response.body?.cancel().catch(() => undefined);
          currentUrl = new URL(location, currentUrl);
          await assertSafeWebhookDestination(currentUrl);
          continue;
        }
        break;
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((val, key) => {
        responseHeaders[key] = val;
      });
      const { text, truncated } = await readBodyWithLimit(
        response.body,
        MAX_RESPONSE_BODY_BYTES,
      );

      return { status: response.status, headers: responseHeaders, body: text, truncated };
    } finally {
      clearTimeout(timeout);
    }
  }

  async sendWebhook(
    userId: string,
    dto: SendWebhookDto,
  ): Promise<WebhookHistoryEntry | WebhookHistoryEntry[]> {
    const repeatCount = dto.repeatCount && dto.repeatCount > 0 ? dto.repeatCount : 1;
    const repeatIntervalMs = dto.repeatIntervalMs ?? 0;
    const method = dto.method ?? 'POST';

    let payload: Record<string, unknown> = {};
    if (dto.payload) {
      payload = dto.payload;
    } else {
      const template = this.templates.find((t) => t.eventType === dto.eventType);
      payload = template ? (template.samplePayload as Record<string, unknown>) : { event: dto.eventType, timestamp: new Date().toISOString() };
    }

    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
      throw new BadGatewayException(
        `Request payload exceeds the ${MAX_REQUEST_BODY_BYTES}-byte limit`,
      );
    }

    await assertSafeWebhookDestination(new URL(dto.endpointUrl));

    const results: WebhookHistoryEntry[] = [];

    for (let i = 0; i < repeatCount; i++) {
      if (i > 0 && repeatIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, repeatIntervalMs));
      }

      const startTime = Date.now();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Webhook-Event': dto.eventType,
        'X-Timestamp': new Date().toISOString(),
        ...(dto.headers ?? {}),
      };

      if (dto.secret) {
        const signature = crypto
          .createHmac('sha256', dto.secret)
          .update(body)
          .digest('hex');
        headers['X-Webhook-Signature'] = `sha256=${signature}`;
      }

      let responseStatus: number | null = null;
      const responseHeaders: Record<string, string> = {};
      let responseBody = '';
      let errorMessage: string | undefined;

      try {
        const outcome = await this.performRequest(
          method,
          dto.endpointUrl,
          headers,
          method !== 'GET' ? body : undefined,
        );
        responseStatus = outcome.status;
        Object.assign(responseHeaders, outcome.headers);
        responseBody = outcome.body;
        if (outcome.truncated) {
          errorMessage = `Response body exceeded the ${MAX_RESPONSE_BODY_BYTES}-byte limit and was truncated`;
        }
      } catch (err) {
        if (err instanceof BadGatewayException || err instanceof BadRequestException) {
          throw err;
        }
        errorMessage =
          err instanceof Error && err.name === 'AbortError'
            ? `Request timed out after ${OUTBOUND_TIMEOUT_MS}ms`
            : err instanceof Error
              ? err.message
              : 'Network error';
        responseBody = JSON.stringify({ error: errorMessage });
      }

      const latencyMs = Date.now() - startTime;

      const entry: WebhookHistoryEntry = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        endpointUrl: dto.endpointUrl,
        eventType: dto.eventType,
        method,
        requestHeaders: redactHeaders(headers),
        payload,
        responseStatus,
        responseHeaders: redactHeaders(responseHeaders),
        responseBody,
        latencyMs,
        error: errorMessage,
        repeatIndex: repeatCount > 1 ? i + 1 : undefined,
      };

      this.recordHistory(userId, entry);
      results.push(entry);
    }

    return repeatCount > 1 ? results : results[0];
  }

  getHistory(userId: string): WebhookHistoryEntry[] {
    return this.historyByUser.get(userId) ?? [];
  }

  async replayWebhook(userId: string, id: string): Promise<WebhookHistoryEntry> {
    const entry = (this.historyByUser.get(userId) ?? []).find((h) => h.id === id);
    if (!entry) {
      throw new NotFoundException('Webhook history entry not found');
    }

    // Redacted secret-shaped headers cannot be reconstructed; skip them
    // instead of transmitting the placeholder value.
    const headers = Object.fromEntries(
      Object.entries(entry.requestHeaders).filter(([, value]) => value !== REDACTED),
    );

    return (await this.sendWebhook(userId, {
      endpointUrl: entry.endpointUrl,
      eventType: entry.eventType,
      payload: entry.payload,
      method: entry.method as 'GET' | 'POST' | 'PUT' | 'PATCH',
      headers,
    })) as WebhookHistoryEntry;
  }
}
