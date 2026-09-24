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
