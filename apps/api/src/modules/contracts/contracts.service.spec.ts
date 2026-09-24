import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ContractsService, WASM_URL_CACHE_TTL_MS } from './contracts.service';
import { Keypair, StrKey } from '@stellar/stellar-sdk';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as nodePath from 'path';

const lookupMock = jest.fn();
jest.mock('dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

const execFileSyncMock = jest.fn();
jest.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

describe('ContractsService', () => {
  let service: ContractsService;
  let configService: ConfigService;

  const mockSecretKey = Keypair.random().secret();
  const mockRpcUrl = 'https://soroban-testnet.stellar.org';

  const createModule = async (
    stellarNetwork?: string,
    overrides: Record<string, string> = {},
  ) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContractsService,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) => {
              if (key === 'STELLAR_RPC_URL') return mockRpcUrl;
              if (key === 'DEPLOYER_SECRET_KEY') return mockSecretKey;
              throw new Error(`Unexpected key: ${key}`);
            }),
            get: jest.fn((key: string, defaultValue?: string) => {
              if (key === 'STELLAR_NETWORK') return stellarNetwork ?? defaultValue ?? 'testnet';
              if (key in overrides) return overrides[key];
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    return {
      service: module.get<ContractsService>(ContractsService),
      configService: module.get<ConfigService>(ConfigService),
    };
  };

  describe('storeUploadedWasm', () => {
    it('stores valid WASM and returns metadata', async () => {
      const { service } = await createModule();
      const buffer = Buffer.from('wasm-content');
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      const result = await service.storeUploadedWasm({
        wasmBuffer: buffer,
        filename: 'test.wasm',
        checksum: sha256,
        source: 'file',
      });

      expect(result.sha256).toBe(sha256);
      expect(result.filename).toBe('test.wasm');
      expect(result.source).toBe('file');
      expect(result.wasmId).toBeDefined();
      expect(result.contentHash).toBeDefined();
    });

    it('verifies SHA-256 checksum successfully', async () => {
      const { service } = await createModule();
      const buffer = Buffer.from('hello-wasm');
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

      const result = await service.storeUploadedWasm({
        wasmBuffer: buffer,
        filename: 'test.wasm',
        checksum: sha256,
      });

      expect(result.sha256).toBe(sha256);
    });

    it('throws UnprocessableEntityException on mismatched checksum', async () => {
      const { service } = await createModule();
      const buffer = Buffer.from('hello-wasm');
      const wrongSha256 = crypto.createHash('sha256').update(Buffer.from('wrong')).digest('hex');

      await expect(
        service.storeUploadedWasm({
          wasmBuffer: buffer,
          filename: 'test.wasm',
          checksum: wrongSha256,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('deduplicates uploads with the same content hash', async () => {
      const { service } = await createModule();
      const buffer = Buffer.from('duplicate-wasm');

      const res1 = await service.storeUploadedWasm({
        wasmBuffer: buffer,
        filename: 'test1.wasm',
      });

      const res2 = await service.storeUploadedWasm({
        wasmBuffer: buffer,
        filename: 'test2.wasm',
      });

      expect(res1.wasmId).toBe(res2.wasmId);
      expect(res1.contentHash).toBe(res2.contentHash);
    });

    it('rejects oversize files', async () => {
      const { service } = await createModule();
      (service as any).maxFileSize = 10; // 10 bytes limit
      const buffer = Buffer.alloc(20, 0);

      await expect(
        service.storeUploadedWasm({
          wasmBuffer: buffer,
          filename: 'large.wasm',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getInfo', () => {
    it('throws BadRequestException for invalid contract ID', async () => {
      const { service } = await createModule();
      await expect(service.getInfo('invalid-id')).rejects.toThrow(BadRequestException);
    });

    it('returns the configured network from ConfigService for testnet', async () => {
      const { service, configService } = await createModule('testnet');
      const validContractId = StrKey.encodeContract(Buffer.alloc(32));

      jest.spyOn((service as any).rpcServer, 'getContractWasmByContractId').mockResolvedValue(Buffer.from('wasm-data'));

      const result = await service.getInfo(validContractId);

      expect(result.contractId).toBe(validContractId);
      expect(result.network).toBe('testnet');
      expect(configService.get).toHaveBeenCalledWith('STELLAR_NETWORK', 'testnet');
    });

    it('returns the configured network from ConfigService for mainnet', async () => {
      const { service, configService } = await createModule('mainnet');
      const validContractId = StrKey.encodeContract(Buffer.alloc(32));

      jest.spyOn((service as any).rpcServer, 'getContractWasmByContractId').mockResolvedValue(Buffer.from('wasm-data'));

      const result = await service.getInfo(validContractId);

      expect(result.contractId).toBe(validContractId);
      expect(result.network).toBe('mainnet');
      expect(configService.get).toHaveBeenCalledWith('STELLAR_NETWORK', 'testnet');
    });

    it('throws NotFoundException if contract is not found on network', async () => {
      const { service } = await createModule();
      const validContractId = StrKey.encodeContract(Buffer.alloc(32));

      jest.spyOn((service as any).rpcServer, 'getContractWasmByContractId').mockRejectedValue(new Error('404'));

      await expect(service.getInfo(validContractId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('invoke', () => {
    const validContractId = StrKey.encodeContract(Buffer.alloc(32));

    it('throws ForbiddenException when no invocation allowlist is configured', async () => {
      const { service } = await createModule();
      await expect(service.invoke(validContractId, 'transfer', [])).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException when the contract is not allowlisted', async () => {
      const { service } = await createModule(undefined, {
        CONTRACT_INVOKE_ALLOWED_CONTRACTS: 'CDIFFERENT',
        CONTRACT_INVOKE_ALLOWED_FUNCTIONS: 'transfer',
      });
      await expect(service.invoke(validContractId, 'transfer', [])).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException when the function is not allowlisted', async () => {
      const { service } = await createModule(undefined, {
        CONTRACT_INVOKE_ALLOWED_CONTRACTS: validContractId,
        CONTRACT_INVOKE_ALLOWED_FUNCTIONS: 'mint',
      });
      await expect(service.invoke(validContractId, 'transfer', [])).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws BadRequestException for an invalid contract ID before checking the allowlist', async () => {
      const { service } = await createModule();
      await expect(service.invoke('invalid-id', 'transfer', [])).rejects.toThrow(
        BadRequestException,
      );
    });

    it('proceeds to the network call when contract and function are both allowlisted', async () => {
      const { service } = await createModule(undefined, {
        CONTRACT_INVOKE_ALLOWED_CONTRACTS: validContractId,
        CONTRACT_INVOKE_ALLOWED_FUNCTIONS: 'transfer',
      });

      jest.spyOn((service as any).rpcServer, 'getAccount').mockRejectedValue(new Error('network unreachable'));

      await expect(service.invoke(validContractId, 'transfer', [])).rejects.toThrow(
        'network unreachable',
      );
    });
  });

  describe('fetchWasmFromGit hardening', () => {
    let sparseArtifact: string | null;

    const simulateGitCheckout = () => {
      sparseArtifact = null;
      execFileSyncMock.mockReset();
      execFileSyncMock.mockImplementation(
        (cmd: string, args: string[], opts?: { cwd?: string }) => {
          if (cmd !== 'git') throw new Error('unexpected command');
          if (args[0] === 'sparse-checkout' && args[1] === 'set') {
            sparseArtifact = args[2] as string;
          }
          if (args[0] === 'checkout' && sparseArtifact && opts?.cwd) {
            const target = nodePath.join(opts.cwd, sparseArtifact);
            if (sparseArtifact === 'link.wasm') {
              // Point at a path that exists on every OS so existsSync is true
              // and the non-regular-file check is what rejects the symlink.
              fs.symlinkSync(process.execPath, target);
            } else {
              fs.mkdirSync(nodePath.dirname(target), { recursive: true });
              fs.writeFileSync(target, Buffer.from('wasm-bytes'));
            }
          }
          return Buffer.alloc(0);
        },
      );
    };

    beforeEach(() => {
      lookupMock.mockReset();
      lookupMock.mockResolvedValue([{ address: '140.82.112.3' }]);
    });

    afterEach(() => {
      execFileSyncMock.mockReset();
    });

    it('passes attacker-controlled URLs and paths as argv elements without a shell', async () => {
      const { service } = await createModule();
      simulateGitCheckout();

      const hostileUrl = 'https://github.com/o/r$(touch).git';
      const buffer = await service.fetchWasmFromGit(hostileUrl, 'contracts/a$(id).wasm');

      expect(buffer.toString()).toBe('wasm-bytes');
      const calls = execFileSyncMock.mock.calls as Array<[string, string[], { cwd?: string }]>;
      const cloneCall = calls.find(([, args]) => args[0] === 'clone');
      expect(cloneCall?.[0]).toBe('git');
      expect(cloneCall?.[1]?.[4]).toContain('$(touch)');
      const setCall = calls.find(([, args]) => args[0] === 'sparse-checkout' && args[1] === 'set');
      expect(setCall?.[1]?.[2]).toContain('$(id)');
    });

    it('rejects traversal artifact paths before invoking git', async () => {
      const { service } = await createModule();
      simulateGitCheckout();

      await expect(
        service.fetchWasmFromGit('https://github.com/o/r.git', '../../etc/passwd'),
      ).rejects.toThrow(BadRequestException);
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('rejects absolute artifact paths', async () => {
      const { service } = await createModule();
      simulateGitCheckout();

      await expect(
        service.fetchWasmFromGit('https://github.com/o/r.git', '/etc/passwd'),
      ).rejects.toThrow(BadRequestException);
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('rejects artifacts that resolve outside the checkout root or are symlinks', async () => {
      const { service } = await createModule();
      simulateGitCheckout();

      await expect(
        service.fetchWasmFromGit('https://github.com/o/r.git', 'contracts/../../../outside.wasm'),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.fetchWasmFromGit('https://github.com/o/r.git', 'link.wasm'),
      ).rejects.toThrow(/not a regular file/);
    });

    it('rejects git@ remote syntax and local repository paths', async () => {
      const { service } = await createModule();
      simulateGitCheckout();

      await expect(
        service.fetchWasmFromGit('git@github.com:o/r.git', 'c.wasm'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.fetchWasmFromGit('/srv/git/repo', 'c.wasm'),
      ).rejects.toThrow(BadRequestException);
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('rejects unallowlisted git hosts', async () => {
      const { service } = await createModule();
      simulateGitCheckout();

      await expect(
        service.fetchWasmFromGit('https://evil.example.com/o/r.git', 'c.wasm'),
      ).rejects.toThrow(/not allowlisted/);
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it('rejects git hosts resolving to private addresses', async () => {
      const { service } = await createModule();
      simulateGitCheckout();
      lookupMock.mockResolvedValue([{ address: '10.0.0.1' }]);

      await expect(
        service.fetchWasmFromGit('https://github.com/o/r.git', 'c.wasm'),
      ).rejects.toThrow(BadRequestException);
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });
  });

  describe('fetchWasmFromUrl hardening', () => {
    const WASM_BYTES = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const wasmResponse = () => new Response(WASM_BYTES, { status: 200 });
    const redirectResponse = (location: string) =>
      new Response(null, { status: 302, headers: { location } });

    let fetchMock: jest.Mock;

    beforeEach(() => {
      lookupMock.mockReset();
      lookupMock.mockResolvedValue([{ address: '93.184.216.34' }]);
      fetchMock = jest.fn();
      (global as { fetch: unknown }).fetch = fetchMock;
    });

    afterEach(() => {
      delete (global as { fetch?: unknown }).fetch;
    });

    it('rejects URLs whose host resolves to private addresses (DNS rebinding)', async () => {
      const { service } = await createModule();
      lookupMock.mockResolvedValue([{ address: '169.254.169.254' }]);

      await expect(
        service.fetchWasmFromUrl('http://rebind.example/contract.wasm'),
      ).rejects.toThrow(BadRequestException);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('follows redirects only after validating each hop', async () => {
      const { service } = await createModule();
      fetchMock
        .mockResolvedValueOnce(redirectResponse('http://198.51.100.7/redirected.wasm'))
        .mockResolvedValueOnce(wasmResponse());

      const { buffer } = await service.fetchWasmFromUrl('http://93.184.216.34/contract.wasm');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0].toString()).toContain('198.51.100.7');
      expect(buffer.readUInt32LE(0)).toBe(0x6d736100);
    });

    it('rejects redirects to private addresses and non-HTTP(S) protocols', async () => {
      const { service } = await createModule();
      fetchMock.mockResolvedValueOnce(redirectResponse('http://127.0.0.1/steal.wasm'));

      await expect(
        service.fetchWasmFromUrl('http://93.184.216.34/contract.wasm'),
      ).rejects.toThrow(BadRequestException);

      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(redirectResponse('ftp://example.com/payload.wasm'));

      await expect(
        service.fetchWasmFromUrl('http://93.184.216.34/contract.wasm'),
      ).rejects.toThrow(BadRequestException);
    });

    it('requires HTTPS in production', async () => {
      const { service } = await createModule('mainnet', { NODE_ENV: 'production' });
      fetchMock.mockResolvedValue(wasmResponse());

      await expect(
        service.fetchWasmFromUrl('http://93.184.216.34/contract.wasm'),
      ).rejects.toThrow(/protocol/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rejects oversize downloads (limit enforced after decompression)', async () => {
      const { service } = await createModule();
      (service as any).maxFileSize = 8;

      fetchMock.mockResolvedValue(new Response(Buffer.from('0123456789abcdef'), { status: 200 }));
      await expect(
        service.fetchWasmFromUrl('http://93.184.216.34/contract.wasm'),
      ).rejects.toThrow(/exceeds maximum size/);

      fetchMock.mockClear();
      fetchMock.mockResolvedValue(
        new Response(WASM_BYTES, { status: 200, headers: { 'content-length': '10485760' } }),
      );
      await expect(
        service.fetchWasmFromUrl('http://93.184.216.34/contract.wasm'),
      ).rejects.toThrow(/exceeds maximum size/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('serves repeated downloads from the URL cache within the TTL', async () => {
      const { service } = await createModule();
      fetchMock.mockResolvedValue(wasmResponse());

      const first = await service.fetchWasmFromUrl('http://93.184.216.34/contract.wasm');
      fetchMock.mockClear();
      const second = await service.fetchWasmFromUrl('http://93.184.216.34/contract.wasm');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(second.metadata.contentHash).toBe(first.metadata.contentHash);
    });

    it('expires stale URL cache entries and re-downloads', async () => {
      const { service } = await createModule();
      fetchMock.mockImplementation(() => Promise.resolve(wasmResponse()));
      lookupMock.mockResolvedValue([{ address: '93.184.216.34' }]);
      const url = 'http://93.184.216.34/contract.wasm';

      await service.fetchWasmFromUrl(url);

      const cache = (
        service as unknown as {
          wasmUrlCache: Map<string, { contentHash: string; cachedAt: number }>;
        }
      ).wasmUrlCache;
      const entry = cache.get(url)!;
      cache.set(url, { ...entry, cachedAt: Date.now() - WASM_URL_CACHE_TTL_MS - 1 });

      fetchMock.mockClear();
      await service.fetchWasmFromUrl(url);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('bounds the URL and content caches', async () => {
      const { service } = await createModule();
      fetchMock.mockImplementation(() => Promise.resolve(wasmResponse()));
      lookupMock.mockResolvedValue([{ address: '93.184.216.34' }]);

      for (let i = 0; i < 105; i++) {
        await service.storeUploadedWasm({
          wasmBuffer: Buffer.from(`wasm-${i}`),
          filename: `w${i}.wasm`,
        });
      }
      for (let i = 0; i < 105; i++) {
        await service.fetchWasmFromUrl(`http://93.184.216.34/contract-${i}.wasm`);
      }

      const caches = service as unknown as {
        wasmStore: Map<string, unknown>;
        wasmUrlCache: Map<string, unknown>;
      };
      expect(caches.wasmStore.size).toBeLessThanOrEqual(100);
      expect(caches.wasmUrlCache.size).toBeLessThanOrEqual(100);
    });
  });
});
