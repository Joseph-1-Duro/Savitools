import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { BadRequestException, GatewayTimeoutException, PayloadTooLargeException } from '@nestjs/common';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ContractAuthorizationGuard } from './guards/contract-authorization.guard';

const JWT_SECRET = 'test-secret';
const ALLOWED_EMAIL = 'admin@example.com';
const OTHER_EMAIL = 'nobody@example.com';

describe('ContractsController', () => {
  let app: NestFastifyApplication;
  let jwtService: JwtService;
  let contractsService: jest.Mocked<
    Pick<
      ContractsService,
      | 'deploy'
      | 'deployConfigured'
      | 'uploadWasmOnly'
      | 'invoke'
      | 'getInfo'
      | 'storeUploadedWasm'
      | 'fetchWasmFromGit'
      | 'fetchWasmFromUrl'
    >
  >;

  beforeAll(async () => {
    contractsService = {
      deploy: jest.fn().mockResolvedValue({ contractId: 'C123', wasmHash: 'abc', txHash: 'tx' }),
      deployConfigured: jest.fn().mockResolvedValue({ contractId: 'C123', wasmHash: 'abc', txHash: 'tx' }),
      uploadWasmOnly: jest.fn().mockResolvedValue({ wasmHash: 'abc', size: 10 }),
      invoke: jest.fn().mockResolvedValue({ result: null, txHash: 'tx' }),
      getInfo: jest.fn(),
      storeUploadedWasm: jest.fn().mockResolvedValue({
        wasmId: 'wasm_123',
        contentHash: 'abc',
        filename: 'contract.wasm',
        size: 10,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e464b934ca495991b7852b855',
        uploadedAt: new Date().toISOString(),
        source: 'file',
      }),
      fetchWasmFromGit: jest.fn().mockResolvedValue(Buffer.from('wasm-bytes')),
      fetchWasmFromUrl: jest.fn().mockResolvedValue({
        buffer: Buffer.from('wasm-bytes'),
        metadata: {
          wasmId: 'wasm_123',
          contentHash: 'abc',
          filename: 'contract.wasm',
          size: 10,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e464b934ca495991b7852b855',
          uploadedAt: new Date().toISOString(),
          source: 'url' as const,
        },
      }),
    };

    const configValues: Record<string, string> = {
      JWT_SECRET,
      CONTRACT_ADMIN_EMAILS: ALLOWED_EMAIL,
    };

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: JWT_SECRET,
        }),
      ],
      controllers: [ContractsController],
      providers: [
        { provide: ContractsService, useValue: contractsService },
       JwtAuthGuard,
       ContractAuthorizationGuard,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => configValues[key] ?? defaultValue),
            getOrThrow: jest.fn((key: string) => {
              if (configValues[key] === undefined) throw new Error(`Missing config: ${key}`);
              return configValues[key];
            }),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    jwtService = moduleRef.get(JwtService);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const tokenFor = (email: string) =>
    jwtService.sign({ sub: 'user-1', email }, { secret: JWT_SECRET });

  describe('POST /contracts/deploy', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/deploy',
      });

      expect(response.statusCode).toBe(401);
      expect(contractsService.deploy).not.toHaveBeenCalled();
    });

    it('rejects authenticated but unauthorized requests with 403', async () => {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/deploy',
        headers: { authorization: `Bearer ${tokenFor(OTHER_EMAIL)}` },
      });

      expect(response.statusCode).toBe(403);
      expect(contractsService.deploy).not.toHaveBeenCalled();
    });

    it('deploys a contract from a URL successfully', async () => {
      const wasmUrl = 'https://example.com/contract.wasm';
      const wasmBuffer = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      (contractsService.fetchWasmFromUrl as jest.Mock).mockResolvedValueOnce({
        buffer: wasmBuffer,
        metadata: {
          wasmId: 'wasm_url_1',
          contentHash: 'hash',
          filename: 'contract.wasm',
          size: wasmBuffer.length,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e464b934ca495991b7852b855',
          uploadedAt: new Date().toISOString(),
          source: 'url' as const,
        },
      });
      (contractsService.deploy as jest.Mock).mockResolvedValueOnce({ contractId: 'C456', wasmHash: 'hash', txHash: 'tx' });

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/deploy',
        headers: { authorization: `Bearer ${tokenFor(ALLOWED_EMAIL)}` },
        payload: { wasm_url: wasmUrl },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({ contractId: 'C456', wasmHash: 'hash', txHash: 'tx' });
      expect(contractsService.fetchWasmFromUrl).toHaveBeenCalledWith(wasmUrl);
      expect(contractsService.deploy).toHaveBeenCalledWith(wasmBuffer, undefined);
    });

    it('returns 400 when the URL is invalid', async () => {
      (contractsService.deploy as jest.Mock).mockClear();
      (contractsService.fetchWasmFromUrl as jest.Mock).mockReset();
      (contractsService.fetchWasmFromUrl as jest.Mock).mockImplementationOnce(() =>
        Promise.reject(new BadRequestException('Invalid URL')),
      );

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/deploy',
        headers: { authorization: `Bearer ${tokenFor(ALLOWED_EMAIL)}` },
        payload: { wasm_url: 'invalid-url' },
      });

      expect(response.statusCode).toBe(400);
      expect(contractsService.deploy).not.toHaveBeenCalled();
      // Restore default mock for subsequent tests
      (contractsService.fetchWasmFromUrl as jest.Mock).mockReset();
      (contractsService.fetchWasmFromUrl as jest.Mock).mockResolvedValue({
        buffer: Buffer.from('wasm-bytes'),
        metadata: {
          wasmId: 'wasm_123',
          contentHash: 'abc',
          filename: 'contract.wasm',
          size: 10,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e464b934ca495991b7852b855',
          uploadedAt: new Date().toISOString(),
          source: 'url' as const,
        },
      });
    });

    it('returns 413 when the downloaded WASM exceeds the size limit', async () => {
      (contractsService.fetchWasmFromUrl as jest.Mock).mockRejectedValueOnce(new PayloadTooLargeException('WASM exceeds 5MB limit'));

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/deploy',
        headers: { authorization: `Bearer ${tokenFor(ALLOWED_EMAIL)}` },
        payload: { wasm_url: 'https://example.com/huge.wasm' },
      });

      expect(response.statusCode).toBe(413);
    });

    it('returns 504 when downloading the WASM times out', async () => {
      (contractsService.fetchWasmFromUrl as jest.Mock).mockRejectedValueOnce(new GatewayTimeoutException('Download timeout'));

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/deploy',
        headers: { authorization: `Bearer ${tokenFor(ALLOWED_EMAIL)}` },
        payload: { wasm_url: 'https://example.com/slow.wasm' },
      });

      expect(response.statusCode).toBe(504);
    });

    it('deploys a contract from an IPFS URL', async () => {
      const wasmUrl = 'ipfs://QmT6Ls9P4i3VvQ7fW4pJ6ymV19X3yQD7v4zFjXWm3KpWvZ';
      const wasmBuffer = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
      (contractsService.fetchWasmFromUrl as jest.Mock).mockResolvedValueOnce({
        buffer: wasmBuffer,
        metadata: {
          wasmId: 'wasm_ipfs',
          contentHash: 'hash',
          filename: 'contract.wasm',
          size: wasmBuffer.length,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e464b934ca495991b7852b855',
          uploadedAt: new Date().toISOString(),
          source: 'url' as const,
        },
      });
      (contractsService.deploy as jest.Mock).mockResolvedValueOnce({ contractId: 'C789', wasmHash: 'hash', txHash: 'tx' });

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/deploy',
        headers: { authorization: `Bearer ${tokenFor(ALLOWED_EMAIL)}` },
        payload: { wasm_url: wasmUrl },
      });

      expect(response.statusCode).toBe(201);
      expect(contractsService.fetchWasmFromUrl).toHaveBeenCalledWith(wasmUrl);
    });

    it('deploys a contract from an Arweave URL', async () => {
      const wasmUrl = 'ar://xyz-abcdefg-hijklmnopqrstuvwxz';
      const wasmBuffer = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
      (contractsService.fetchWasmFromUrl as jest.Mock).mockResolvedValueOnce({
        buffer: wasmBuffer,
        metadata: {
          wasmId: 'wasm_ar',
          contentHash: 'hash',
          filename: 'contract.wasm',
          size: wasmBuffer.length,
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e464b934ca495991b7852b855',
          uploadedAt: new Date().toISOString(),
          source: 'url' as const,
        },
      });
      (contractsService.deploy as jest.Mock).mockResolvedValueOnce({ contractId: 'C101', wasmHash: 'hash', txHash: 'tx' });

      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/deploy',
        headers: { authorization: `Bearer ${tokenFor(ALLOWED_EMAIL)}` },
        payload: { wasm_url: wasmUrl },
      });

      expect(response.statusCode).toBe(201);
      expect(contractsService.fetchWasmFromUrl).toHaveBeenCalledWith(wasmUrl);
    });
  });

  describe('POST /contracts/deploy/wizard', () => {
    it('rejects out of order execution if step 1 is skipped', async () => {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/deploy/wizard',
        headers: { authorization: `Bearer ${tokenFor(ALLOWED_EMAIL)}` },
        payload: { step: 2, stepToken: 'fake-token' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('successfully completes wizard steps sequentially', async () => {
      // Valid WASM binary with magic header (0x0061736d little endian = 0x6d736100)
      const validWasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
      const wasmBase64 = validWasm.toString('base64');

      // Step 1
      const step1Res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/deploy/wizard',
        headers: { authorization: `Bearer ${tokenFor(ALLOWED_EMAIL)}` },
        payload: { step: 1, wasmBase64 },
      });

      expect(step1Res.statusCode).toBe(201);
      const step1Json = step1Res.json();
      expect(step1Json.stepToken).toBeDefined();
      const token = step1Json.stepToken;

      // Step 2
      const step2Res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/deploy/wizard',
        headers: { authorization: `Bearer ${tokenFor(ALLOWED_EMAIL)}` },
        payload: { step: 2, stepToken: token, args: '[]' },
      });

      expect(step2Res.statusCode).toBe(201);
      const step2Json = step2Res.json();
      expect(step2Json.stepToken).toBeDefined();
      const token2 = step2Json.stepToken;

      // Step 3
      const step3Res = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/deploy/wizard',
        headers: { authorization: `Bearer ${tokenFor(ALLOWED_EMAIL)}` },
        payload: { step: 3, stepToken: token2 },
      });

      expect(step3Res.statusCode).toBe(201);
      const step3Json = step3Res.json();
      expect(step3Json.contractAddress).toBe('C123');
      expect(step3Json.txHash).toBe('tx');
    });
  });

  describe('POST /contracts/:contractId/invoke', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/C123/invoke',
        payload: { functionName: 'transfer', args: [] },
      });

      expect(response.statusCode).toBe(401);
      expect(contractsService.invoke).not.toHaveBeenCalled();
    });

    it('rejects authenticated but unauthorized requests with 403', async () => {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/C123/invoke',
        headers: { authorization: `Bearer ${tokenFor(OTHER_EMAIL)}` },
        payload: { functionName: 'transfer', args: [] },
      });

      expect(response.statusCode).toBe(403);
      expect(contractsService.invoke).not.toHaveBeenCalled();
    });

    it('allows an authorized user through to the service', async () => {
      const response = await app.getHttpAdapter().getInstance().inject({
        method: 'POST',
        url: '/contracts/C123/invoke',
        headers: { authorization: `Bearer ${tokenFor(ALLOWED_EMAIL)}` },
        payload: { functionName: 'transfer', args: [] },
      });

      expect(response.statusCode).toBe(201);
      expect(contractsService.invoke).toHaveBeenCalledWith('C123', 'transfer', []);
    });
  });
});
