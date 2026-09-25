import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { WebhookController } from './webhook.controller';

function guardNames(handler: Function): string[] {
  const guards = Reflect.getMetadata('__guards__', handler) as Array<new () => unknown>;
  return (guards ?? []).map((guard) => guard.name);
}

describe('WebhookController authorization', () => {
  it('keeps only catalog reads public', () => {
    expect(guardNames(WebhookController.prototype.getTemplates)).toHaveLength(0);
  });

  it('keeps the signing status public: it reports config, never a secret', () => {
    expect(guardNames(WebhookController.prototype.getSigningStatus)).toHaveLength(0);
  });

  it('reports the timestamped wire format from the signing status endpoint', () => {
    const controller = new WebhookController({
      getSigningStatus: () => ({
        enabled: true,
        algorithm: 'hmac-sha256' as const,
        signatureHeader: 'X-SaviTools-Signature',
        timestampHeader: 'X-SaviTools-Timestamp',
        replayWindowSeconds: 300,
        signedPayloadFormat: '<timestamp>.<body>',
        signatureFormat: 'sha256=<hex>',
        signedPayloadEncoding: 'utf-8' as const,
        maxSkewSeconds: 60,
        perRequestSecretSupported: true,
      }),
    } as never);

    const status = controller.getSigningStatus();
    expect(status.signedPayloadFormat).toBe('<timestamp>.<body>');
    expect(JSON.stringify(status)).not.toMatch(/body-only|no timestamp/i);
  });

  it('requires authentication for send, save, history and replay', () => {
    expect(guardNames(WebhookController.prototype.sendWebhook)).toContain('JwtAuthGuard');
    expect(guardNames(WebhookController.prototype.saveTemplate)).toContain('JwtAuthGuard');
    expect(guardNames(WebhookController.prototype.getHistory)).toContain('JwtAuthGuard');
    expect(guardNames(WebhookController.prototype.replayWebhook)).toContain('JwtAuthGuard');
  });

  it('returns 401 when no token is presented', () => {
    const guard = new JwtAuthGuard(
      { verify: jest.fn() } as never,
      { getOrThrow: jest.fn() } as never,
    );
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ cookies: {}, headers: {} }),
      }),
    };

    expect(() => guard.canActivate(context as never)).toThrow(UnauthorizedException);
  });

  it('returns 401 when the token is invalid', () => {
    const guard = new JwtAuthGuard(
      { verify: () => { throw new Error('jwt expired'); } } as never,
      { getOrThrow: () => 'secret' } as never,
    );
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ cookies: { savitools_access_token: 'bad.token.here' }, headers: {} }),
      }),
    };

    expect(() => guard.canActivate(context as never)).toThrow(UnauthorizedException);
  });
});
