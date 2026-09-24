import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FederationService, TOML_MAX_BYTES } from './federation.service';

const VALID_KEY =
  'GDJ47UQJNT6UOMV3CLNZ43XGDKOUM3UHV7V3FF3W4KMIRRNICNSS2N2H';

function mockFetch(
  responses: Record<
    string,
    { ok: boolean; status?: number; json?: unknown; text?: string }
  >,
) {
  global.fetch = jest.fn().mockImplementation(
    (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      for (const [pattern, resp] of Object.entries(responses)) {
        if (url.includes(pattern)) {
          return Promise.resolve({
            ok: resp.ok,
            status: resp.status ?? (resp.ok ? 200 : 404),
            json: () => Promise.resolve(resp.json ?? {}),
            text: () => Promise.resolve(resp.text ?? ''),
          });
        }
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
        text: () => Promise.resolve(''),
      });
    },
  );
}

describe('FederationService', () => {
  let service: FederationService;

  beforeEach(() => {
    jest.restoreAllMocks();
    service = new FederationService();
  });

  describe('resolveFederation', () => {
    it('rejects invalid input', async () => {
      await expect(service.resolveFederation('not-valid!!!')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('reverse-looks up a public key via Stellar federation', async () => {
      mockFetch({
        'federation.stellar.org/federation': {
          ok: true,
          json: {
            stellar_address: 'alice*stellar.org',
            memo: 'test-memo',
            memo_type: 'text',
            home_domain: 'stellar.org',
          },
        },
      });

      const result = await service.resolveFederation(VALID_KEY);

      expect(result.stellarAddress).toBe(VALID_KEY);
      expect(result.federationAddress).toBe('alice*stellar.org');
      expect(result.memo).toBe('test-memo');
      expect(result.memoType).toBe('text');
      expect(result.homeDomain).toBe('stellar.org');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('type=id'),
        expect.anything(),
      );
    });

    it('resolves a federation address via Stellar federation', async () => {
      mockFetch({
        'federation.stellar.org/federation': {
          ok: true,
          json: {
            stellar_address: VALID_KEY,
            memo: '',
            memo_type: 'none',
            home_domain: 'stellar.org',
          },
        },
      });

      const result = await service.resolveFederation('alice*stellar.org');

      expect(result.stellarAddress).toBe(VALID_KEY);
      expect(result.federationAddress).toBe('alice*stellar.org');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('type=name'),
        expect.anything(),
      );
    });

    it('looks up domain and returns home domain', async () => {
      mockFetch({
        'stellar.org/.well-known/stellar.toml': {
          ok: true,
          text: 'FEDERATION_SERVER="https://stellar.org/federation"\n',
        },
      });

      const result = await service.resolveFederation('stellar.org');

      expect(result.homeDomain).toBe('stellar.org');
    });

    it('throws NotFoundException when domain has no federation server', async () => {
      mockFetch({
        'example.com/.well-known/stellar.toml': {
          ok: true,
          text: 'VERSION="1.0.0"\n',
        },
      });

      await expect(service.resolveFederation('example.com')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('handles federation lookup returning non-200', async () => {
      mockFetch({
        'federation.stellar.org/federation': {
          ok: false,
          status: 404,
        },
      });

      await expect(service.resolveFederation(VALID_KEY)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('strips protocol prefix from domain input', async () => {
      mockFetch({
        'stellar.org/.well-known/stellar.toml': {
          ok: true,
          text: 'FEDERATION_SERVER="https://stellar.org/federation"\n',
        },
      });

      const result = await service.resolveFederation('https://stellar.org');
      expect(result.homeDomain).toBe('stellar.org');
    });
  });

  describe('getToml', () => {
    it('fetches and parses a valid stellar.toml', async () => {
      const tomlContent = [
        'VERSION="1.0.0"',
        'NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"',
        'FEDERATION_SERVER="https://stellar.org/federation"',
        'TRANSFER_SERVER="https://stellar.org/api"',
        'WEB_AUTH_ENDPOINT="https://stellar.org/auth"',
        'TRANSFER_SERVER_SEP0024="https://stellar.org/sep24"',
        'DIRECT_PAYMENT_SERVER="https://stellar.org/sep31"',
        '',
        '[[ACCOUNTS]]',
        'PUBLIC_KEY="GBRPYHIL2CI3FNQ4BXHYMNN6AOZDMBCCCCN4QFY3SALZGXAAKIRFSTJ"',
        'NAME="SDF"',
        '',
        '[[CURRENCIES]]',
        'CODE="USDC"',
        'ISSUER="GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"',
        'DISPLAY_DECIMALS=7',
        '',
        '[[VALIDATORS]]',
        'PUBLIC_KEY="GBRPYHIL2CI3FNQ4BXHYMNN6AOZDMBCCCCN4QFY3SALZGXAAKIRFSTJ"',
        'NAME="SDF #1"',
        'HOST="horizon.stellar.org"',
        '',
        '[DOCUMENTATION]',
        'PRINCIPALS_NAME="Stellar Development Foundation"',
        'PRINCIPAL_EMAIL="info@stellar.org"',
        'PROJECT_URL="https://stellar.org"',
      ].join('\n');

      mockFetch({
        'stellar.org/.well-known/stellar.toml': {
          ok: true,
          text: tomlContent,
        },
      });

      const result = await service.getToml('stellar.org');

      expect(result.version).toBe('1.0.0');
      expect(result.networkPassphrase).toBe(
        'Public Global Stellar Network ; September 2015',
      );
      expect(result.federationServer).toBe(
        'https://stellar.org/federation',
      );
      expect(result.transferServer).toBe('https://stellar.org/api');
      expect(result.webAuthEndpoint).toBe('https://stellar.org/auth');
      expect(result.transferServerSep0024).toBe(
        'https://stellar.org/sep24',
      );
      expect(result.directPaymentServer).toBe(
        'https://stellar.org/sep31',
      );
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].PUBLIC_KEY).toContain('GBRPY');
      expect(result.currencies).toHaveLength(1);
      expect(result.currencies[0].code).toBe('USDC');
      expect(result.currencies[0].display_decimals).toBe(7);
      expect(result.validators).toHaveLength(1);
      expect(result.validators[0].NAME).toBe('SDF #1');
      expect(result.documentation?.PRINCIPALS_NAME).toBe(
        'Stellar Development Foundation',
      );
      expect(result.fetchLatencyMs).toBeGreaterThanOrEqual(0);
      expect(result.validationWarnings).toEqual([]);
    });

    it('generates warnings for missing required fields', async () => {
      const tomlContent = 'VERSION="1.0.0"\n';

      mockFetch({
        'example.com/.well-known/stellar.toml': {
          ok: true,
          text: tomlContent,
        },
      });

      const result = await service.getToml('example.com');

      expect(result.validationWarnings).toContain(
        'Missing required SEP-1 field: ACCOUNTS',
      );
    });

    it('throws BadRequestException for invalid domain', async () => {
      await expect(service.getToml('not a domain!!!')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws NotFoundException for missing stellar.toml', async () => {
      mockFetch({
        'missing.com/.well-known/stellar.toml': {
          ok: false,
          status: 404,
        },
      });

      await expect(service.getToml('missing.com')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException for malformed TOML', async () => {
      mockFetch({
        'bad.com/.well-known/stellar.toml': {
          ok: true,
          text: 'this is not valid [[[',
        },
      });

      await expect(service.getToml('bad.com')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('handles inline comments and multi-line strings', async () => {
      const tomlContent = [
        'VERSION = "1.0.0" # inline comment',
        'ACCOUNTS = []',
        'DESCRIPTION = """',
        'This is a',
        'multi-line string',
        '"""',
      ].join('\n');

      mockFetch({
        'comments.com/.well-known/stellar.toml': {
          ok: true,
          text: tomlContent,
        },
      });

      const result = await service.getToml('comments.com');
      expect(result.version).toBe('1.0.0');
      expect(result.validationWarnings).toEqual([]);
    });

    // ── Regression tests for the bounded parser (Savitura/Savitools#220) ──

    it('rejects oversized stellar.toml with a controlled 413', async () => {
      mockFetch({
        'huge.com/.well-known/stellar.toml': {
          ok: true,
          text: 'A="' + 'x'.repeat(TOML_MAX_BYTES + 1) + '"',
        },
      });

      await expect(service.getToml('huge.com')).rejects.toThrow(
        PayloadTooLargeException,
      );
    });

    it('rejects deeply nested TOML with a controlled 400', async () => {
      const depth = 100;
      // Chain inline tables: a.b.c... each [bracket] adds one nesting level.
      let line = 'value = 1';
      for (let i = 0; i < depth; i++) {
        line = `table_${i} = { ${line} }`;
      }

      mockFetch({
        'deep.com/.well-known/stellar.toml': {
          ok: true,
          text: line,
        },
      });

      await expect(service.getToml('deep.com')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.getToml('deep.com')).rejects.toThrow(
        /nesting depth/i,
      );
    });

    it('cannot pollute Object.prototype via a pollution payload', async () => {
      const pollution = '[[CURRENCIES]]\nCODE="USDC"\nISSUER="GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"\n__proto__ = { "polluted": true }\n';

      mockFetch({
        'evil.com/.well-known/stellar.toml': {
          ok: true,
          text: pollution,
        },
      });

      await service.getToml('evil.com');

      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(
        (Object.prototype as unknown as Record<string, unknown>).polluted,
      ).toBeUndefined();
    });

    it('rejects malformed TOML with a controlled 400', async () => {
      mockFetch({
        'broken.com/.well-known/stellar.toml': {
          ok: true,
          text: 'key = [unclosed',
        },
      });

      await expect(service.getToml('broken.com')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('keeps SSRF validation active around the fetch', async () => {
      await expect(service.getToml('169.254.169.254')).rejects.toThrow();
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('getSepSupport', () => {
    it('detects all SEPs when fully configured', async () => {
      const tomlContent = [
        'ACCOUNTS = []',
        'TRANSFER_SERVER="https://anchor.com/api"',
        'WEB_AUTH_ENDPOINT="https://anchor.com/auth"',
        'TRANSFER_SERVER_SEP0024="https://anchor.com/sep24"',
        'DIRECT_PAYMENT_SERVER="https://anchor.com/sep31"',
      ].join('\n');

      mockFetch({
        'full.com/.well-known/stellar.toml': {
          ok: true,
          text: tomlContent,
        },
        'anchor.com/api/info': { ok: true },
        'anchor.com/auth/web_auth': { ok: true },
      });

      const result = await service.getSepSupport('full.com');

      expect(result.seps).toHaveLength(5);
      for (const sep of result.seps) {
        expect(sep.supported).toBe(true);
        expect(sep.probeStatus).toBe('green');
      }
    });

    it('returns yellow probe when endpoint is declared but returns non-200', async () => {
      const tomlContent = [
        'ACCOUNTS = []',
        'WEB_AUTH_ENDPOINT="https://anchor.com/auth"',
      ].join('\n');

      mockFetch({
        'partial.com/.well-known/stellar.toml': {
          ok: true,
          text: tomlContent,
        },
        'anchor.com/auth/web_auth': { ok: false, status: 500 },
      });

      const result = await service.getSepSupport('partial.com');

      const sep10 = result.seps.find((s) => s.number === 10);
      expect(sep10?.supported).toBe(true);
      expect(sep10?.probeStatus).toBe('yellow');
    });

    it('returns yellow probe when endpoint throws a network error', async () => {
      const tomlContent = [
        'ACCOUNTS = []',
        'TRANSFER_SERVER="https://anchor.com/api"',
      ].join('\n');

      global.fetch = jest.fn().mockImplementation(
        (input: string | URL | Request, _init?: RequestInit) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.includes('stellar.toml')) {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve({}),
              text: () => Promise.resolve(tomlContent),
            });
          }
          return Promise.reject(new Error('timeout'));
        },
      );

      const result = await service.getSepSupport('timeout.com');

      const sep6 = result.seps.find((s) => s.number === 6);
      expect(sep6?.supported).toBe(true);
      expect(sep6?.probeStatus).toBe('yellow');
    });

    it('marks SEPs as unsupported when not declared in TOML', async () => {
      const tomlContent = 'ACCOUNTS = []\n';

      mockFetch({
        'bare.com/.well-known/stellar.toml': {
          ok: true,
          text: tomlContent,
        },
      });

      const result = await service.getSepSupport('bare.com');

      expect(result.seps.find((s) => s.number === 1)?.supported).toBe(true);
      expect(result.seps.find((s) => s.number === 6)?.supported).toBe(false);
      expect(result.seps.find((s) => s.number === 10)?.supported).toBe(
        false,
      );
      expect(result.seps.find((s) => s.number === 24)?.supported).toBe(
        false,
      );
      expect(result.seps.find((s) => s.number === 31)?.supported).toBe(
        false,
      );
    });

    it('returns all red when TOML cannot be fetched', async () => {
      mockFetch({
        'down.com/.well-known/stellar.toml': {
          ok: false,
          status: 500,
        },
      });

      const result = await service.getSepSupport('down.com');

      expect(result.seps).toHaveLength(5);
      for (const sep of result.seps) {
        expect(sep.supported).toBe(false);
        expect(sep.probeStatus).toBe('red');
      }
    });

    it('throws BadRequestException for invalid domain', async () => {
      await expect(service.getSepSupport('not valid!!!')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('buildTransferRequestLink (#217)', () => {
    const ANCHOR_TOML = [
      'ACCOUNTS = []',
      'TRANSFER_SERVER="https://anchor.example/api"',
      'TRANSFER_SERVER_SEP0024="https://anchor.example/sep24"',
      'DIRECT_PAYMENT_SERVER="https://anchor.example/sep31"',
      '',
      '[[CURRENCIES]]',
      'CODE="USDC"',
      'ISSUER="GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"',
    ].join('\n');

    beforeEach(() => {
      mockFetch({
        'anchor.example/.well-known/stellar.toml': {
          ok: true,
          text: ANCHOR_TOML,
        },
        'bare.example/.well-known/stellar.toml': {
          ok: true,
          text: 'ACCOUNTS = []\nTRANSFER_SERVER="https://bare.example/api"\n',
        },
      });
    });

    it('golden SEP-6 deposit link matches SEP-6 parameter and encoding rules', async () => {
      const result = await service.buildTransferRequestLink('anchor.example', {
        sep: '6',
        asset: 'USDC',
        amount: '100.50',
        memo: 'ref 42',
        account: VALID_KEY,
      });

      expect(result.endpoint).toBe('https://anchor.example/api');
      expect(result.url).toBe(
        'https://anchor.example/api/transactions?type=deposit&asset_code=USDC' +
          `&account=${VALID_KEY}&amount=100.50&memo=ref+42&memo_type=text`,
      );
      expect(result.warning).toMatch(/will not sign or submit/i);
    });

    it('golden SEP-24 interactive link matches SEP-24 rules', async () => {
      const result = await service.buildTransferRequestLink('anchor.example', {
        sep: '24',
        asset: 'USDC',
        amount: '10',
        account: VALID_KEY,
      });

      expect(result.endpoint).toBe('https://anchor.example/sep24');
      expect(result.url).toBe(
        'https://anchor.example/sep24/?asset_code=USDC&amount=10' +
          `&account=${VALID_KEY}`,
      );
    });

    it('golden SEP-31 direct payment link matches SEP-31 rules', async () => {
      const result = await service.buildTransferRequestLink('anchor.example', {
        sep: '31',
        asset: 'USDC',
        amount: '250',
        callback: 'https://wallet.example/sep31-done',
      });

      expect(result.endpoint).toBe('https://anchor.example/sep31');
      expect(result.url).toBe(
        'https://anchor.example/sep31/?asset_code=USDC&amount=250&destination=https%3A%2F%2Fwallet.example%2Fsep31-done',
      );
    });

    it('keeps amounts and memos as verbatim strings (no float conversion)', async () => {
      const result = await service.buildTransferRequestLink('anchor.example', {
        sep: '6',
        asset: 'USDC',
        amount: '0.0000001',
        memo: 'M-10000000000000000',
        account: VALID_KEY,
      });

      expect(result.url).toContain('amount=0.0000001');
      expect(result.url).toContain('memo=M-10000000000000000');
      expect(result.amount).toBe('0.0000001');
    });

    it('errors when the SEP endpoint is missing from stellar.toml', async () => {
      await expect(
        service.buildTransferRequestLink('bare.example', {
          sep: '24',
          asset: 'USDC',
          amount: '10',
          account: VALID_KEY,
        }),
      ).rejects.toThrow(/TRANSFER_SERVER_SEP0024/);
    });

    it('errors when the asset is unsupported by the anchor', async () => {
      await expect(
        service.buildTransferRequestLink('anchor.example', {
          sep: '6',
          asset: 'NOPE',
          amount: '10',
          account: VALID_KEY,
        }),
      ).rejects.toThrow(/not supported/);
    });

    it('errors on invalid amounts, malformed callbacks, and bad accounts', async () => {
      await expect(
        service.buildTransferRequestLink('anchor.example', {
          sep: '6',
          asset: 'USDC',
          amount: '1e5',
          account: VALID_KEY,
        }),
      ).rejects.toThrow(/decimal string/);

      await expect(
        service.buildTransferRequestLink('anchor.example', {
          sep: '6',
          asset: 'USDC',
          amount: '10',
          account: VALID_KEY,
          callback: 'http://insecure.example/cb',
        }),
      ).rejects.toThrow(/callback/);

      await expect(
        service.buildTransferRequestLink('anchor.example', {
          sep: '24',
          asset: 'USDC',
          amount: '10',
          account: 'NOT-A-KEY',
        }),
      ).rejects.toThrow(/public key/);

      await expect(
        service.buildTransferRequestLink('anchor.example', {
          sep: '24',
          asset: 'USDC',
          amount: '10',
        }),
      ).rejects.toThrow(/account/);
    });
  });
});
