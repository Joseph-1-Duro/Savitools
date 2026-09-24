import {
  Injectable,
  BadRequestException,
  UnprocessableEntityException,
  ForbiddenException,
  NotFoundException,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetricsService } from '../metrics/metrics.service';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { assertPublicHostname } from '../webhook/ssrf-guard';
import { AbiCatalogEntry, buildAbiCatalog, encodeAbiArgument } from './abi-catalog';
import { AttachAbiDto, ABI_MAX_BYTES } from './dto/attach-abi.dto';
import {
  rpc,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  Operation,
  nativeToScVal,
  scValToNative,
  hash,
  Address,
  StrKey,
  xdr,
} from "@stellar/stellar-sdk";

export const GIT_CLONE_TIMEOUT_MS = 30_000;
export const WASM_URL_MAX_REDIRECTS = 5;
export const WASM_URL_CACHE_TTL_MS = 10 * 60 * 1000;
export const WASM_URL_CACHE_MAX_ENTRIES = 100;
export const WASM_CONTENT_CACHE_MAX_ENTRIES = 100;
export const DEFAULT_WASM_GIT_ALLOWED_HOSTS = ['github.com', 'gitlab.com'];

export interface WasmMetadata {
  wasmId: string;
  contentHash: string;
  filename: string;
  size: number;
  sha256: string;
  uploadedAt: string;
  source: 'file' | 'git' | 'url';
}

/** Attached-ABI catalog bounds — mirrors the wizard session TTL pattern. */
export const ABI_CATALOG_MAX_ENTRIES = 200;
export const ABI_CATALOG_TTL_MS = 60 * 60 * 1000; // 1 hour

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);
  private readonly rpcServer: rpc.Server;
  private readonly deployer: Keypair;
  private readonly networkPassphrase: string;
  private readonly isProduction: boolean;
  private readonly allowedGitHosts: string[];
  private readonly wasmStore = new Map<string, { buffer: Buffer; metadata: WasmMetadata }>();
  private readonly wasmUrlCache = new Map<string, { contentHash: string; cachedAt: number }>();
  private readonly maxFileSize: number;
  private readonly abiCatalogs = new Map<string, { entry: AbiCatalogEntry; expiresAt: number }>();

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly metricsService?: MetricsService,
  ) {
    const rpcUrl = this.configService.getOrThrow<string>("STELLAR_RPC_URL");
    const network = this.configService.get<string>(
      "STELLAR_NETWORK",
      "testnet",
    );

    const isProduction =
      this.configService.get<string>("NODE_ENV") === "production" ||
      network.toLowerCase() === "mainnet" ||
      network.toLowerCase() === "public";

    if (isProduction && rpcUrl.startsWith("http://")) {
      throw new Error(
        "Plaintext RPC (http) is not allowed for production signing",
      );
    }

    this.isProduction = isProduction;

    const configuredGitHosts = this.configService.get<string>('WASM_GIT_ALLOWED_HOSTS');
    this.allowedGitHosts = configuredGitHosts
      ? configuredGitHosts.split(',').map((host) => host.trim().toLowerCase()).filter((host) => host.length > 0)
      : DEFAULT_WASM_GIT_ALLOWED_HOSTS;

    this.rpcServer = new rpc.Server(rpcUrl, { allowHttp: !isProduction });

    const secretKey = this.configService.getOrThrow<string>(
      "DEPLOYER_SECRET_KEY",
    );
    this.deployer = Keypair.fromSecret(secretKey);

    this.networkPassphrase =
      this.configService.get<string>("STELLAR_NETWORK_PASSPHRASE") ||
      (network.toLowerCase() === "mainnet" || network.toLowerCase() === "public"
        ? Networks.PUBLIC
        : Networks.TESTNET);

    const configuredLimit = this.configService.get<string>('MAX_WASM_FILE_SIZE');
    this.maxFileSize = configuredLimit ? parseInt(configuredLimit, 10) : 5 * 1024 * 1024; // default 5MB
  }

  async storeUploadedWasm(params: {
    wasmBuffer: Buffer;
    filename: string;
    checksum?: string;
    source?: 'file' | 'git' | 'url';
  }): Promise<WasmMetadata> {
    const { wasmBuffer, filename, checksum, source = 'file' } = params;

    if (!wasmBuffer || wasmBuffer.length === 0) {
      throw new BadRequestException('WASM file is empty');
    }

    if (wasmBuffer.length > this.maxFileSize) {
      throw new BadRequestException(`WASM file exceeds maximum size of ${this.maxFileSize / (1024 * 1024)}MB`);
    }

    const calculatedSha256 = crypto.createHash('sha256').update(wasmBuffer).digest('hex');

    if (checksum) {
      if (checksum.toLowerCase() !== calculatedSha256.toLowerCase()) {
        throw new UnprocessableEntityException(
          `Checksum verification failed: expected ${checksum}, got ${calculatedSha256}`
        );
      }
    }

    const contentHash = hash(wasmBuffer).toString('hex');
    const wasmId = `wasm_${contentHash.substring(0, 16)}`;

    // Deduplicate: if contentHash already exists, return existing metadata
    if (this.wasmStore.has(contentHash)) {
      return this.wasmStore.get(contentHash)!.metadata;
    }

    const metadata: WasmMetadata = {
      wasmId,
      contentHash,
      filename,
      size: wasmBuffer.length,
      sha256: calculatedSha256,
      uploadedAt: new Date().toISOString(),
      source,
    };

    this.wasmStore.set(contentHash, { buffer: wasmBuffer, metadata });
    this.pruneContentCache();
    this.logger.log(`Stored WASM ${wasmId} (${metadata.size} bytes, sha256: ${calculatedSha256})`);

    return metadata;
  }

  private pruneContentCache(): void {
    while (this.wasmStore.size > WASM_CONTENT_CACHE_MAX_ENTRIES) {
      const oldest = this.wasmStore.keys().next().value;
      if (oldest === undefined) break;
      this.wasmStore.delete(oldest);
    }
  }

  private pruneUrlCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.wasmUrlCache) {
      if (now - entry.cachedAt >= WASM_URL_CACHE_TTL_MS) {
        this.wasmUrlCache.delete(key);
      }
    }
    while (this.wasmUrlCache.size > WASM_URL_CACHE_MAX_ENTRIES) {
      const oldest = this.wasmUrlCache.keys().next().value;
      if (oldest === undefined) break;
      this.wasmUrlCache.delete(oldest);
    }
  }

  private async assertSafeWasmUrl(
    parsedUrl: URL,
  ): Promise<void> {
    const allowHttp = !this.isProduction;
    if (parsedUrl.protocol !== 'https:' && !(allowHttp && parsedUrl.protocol === 'http:')) {
      throw new BadRequestException(`Unsupported WASM URL protocol: ${parsedUrl.protocol}`);
    }
    await assertPublicHostname(parsedUrl.hostname);
  }

  private async assertSafeGitRepoUrl(gitRepoUrl: string): Promise<string> {
    // Reject scp-like remote syntax (`git@host:repo`) before anything else.
    if (gitRepoUrl.startsWith('git@')) {
      throw new BadRequestException('Unsupported Git remote syntax: git@ remotes are not allowed');
    }

    let parsed: URL;
    try {
      parsed = new URL(gitRepoUrl);
    } catch {
      throw new BadRequestException('Invalid Git repository URL');
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'git:') {
      throw new BadRequestException(
        `Unsupported Git repository URL protocol: ${parsed.protocol}`,
      );
    }

    if (!parsed.hostname) {
      throw new BadRequestException('Git repository URL is missing a host');
    }

    const host = parsed.hostname.toLowerCase();
    if (!this.allowedGitHosts.includes(host)) {
      throw new BadRequestException(`Git host ${host} is not allowlisted for WASM import`);
    }

    await assertPublicHostname(parsed.hostname);

    return parsed.toString();
  }

  private assertArtifactPathInsideCheckout(artifactPath: string): string {
    if (!artifactPath || artifactPath.trim().length === 0) {
      throw new BadRequestException('WASM artifact path is required');
    }

    if (path.isAbsolute(artifactPath) || artifactPath.startsWith('\\') || /^[a-zA-Z]:/.test(artifactPath)) {
      throw new BadRequestException('WASM artifact path must be relative');
    }

    const normalized = path.normalize(artifactPath);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new BadRequestException('WASM artifact path escapes the checkout directory');
    }

    return normalized;
  }

  private resolveArtifactInsideCheckout(tempDir: string, normalizedArtifactPath: string): string {
    const checkoutRoot = path.resolve(tempDir);
    const resolved = path.resolve(checkoutRoot, normalizedArtifactPath);
    const relative = path.relative(checkoutRoot, resolved);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new BadRequestException('WASM artifact path escapes the temporary checkout directory');
    }

    if (!fs.existsSync(resolved)) {
      throw new NotFoundException(
        `WASM artifact not found at path ${normalizedArtifactPath} in repository`,
      );
    }

    // Symlinks are rejected so a hostile repository cannot point the artifact
    // outside of the temporary checkout root.
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile()) {
      throw new BadRequestException('WASM artifact is not a regular file');
    }

    return resolved;
  }

  async fetchWasmFromGit(gitRepoUrl: string, artifactPath: string): Promise<Buffer> {
    const repoUrl = await this.assertSafeGitRepoUrl(gitRepoUrl);
    const normalizedArtifactPath = this.assertArtifactPathInsideCheckout(artifactPath);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'savitools-git-'));
    try {
      this.logger.log(`Cloning read-only Git repo ${repoUrl} into ${tempDir}...`);
      // Argument-array invocation: no shell, so command metacharacters in the
      // attacker-controlled URL or artifact path are never interpreted.
      execFileSync('git', ['clone', '--depth', '1', '--no-checkout', repoUrl, '.'], {
        cwd: tempDir,
        timeout: GIT_CLONE_TIMEOUT_MS,
        stdio: 'ignore',
      });
      execFileSync('git', ['sparse-checkout', 'init', '--cone'], {
        cwd: tempDir,
        timeout: GIT_CLONE_TIMEOUT_MS,
        stdio: 'ignore',
      });
      execFileSync('git', ['sparse-checkout', 'set', normalizedArtifactPath], {
        cwd: tempDir,
        timeout: GIT_CLONE_TIMEOUT_MS,
        stdio: 'ignore',
      });
      execFileSync('git', ['checkout'], {
        cwd: tempDir,
        timeout: GIT_CLONE_TIMEOUT_MS,
        stdio: 'ignore',
      });

      const fullArtifactPath = this.resolveArtifactInsideCheckout(tempDir, normalizedArtifactPath);
      return fs.readFileSync(fullArtifactPath);
    } catch (err: any) {
      if (err instanceof NotFoundException || err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Failed to fetch WASM from Git repository: ${err.message}`);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }

  async fetchWasmFromUrl(url: string): Promise<{ buffer: Buffer; metadata: WasmMetadata }> {
    const resolvedUrl = this.resolveWasmUrl(url);
    this.pruneUrlCache();

    const cachedEntry = this.wasmUrlCache.get(resolvedUrl);
    if (cachedEntry) {
      const cached = this.wasmStore.get(cachedEntry.contentHash);
      if (cached && Date.now() - cachedEntry.cachedAt < WASM_URL_CACHE_TTL_MS) {
        return { buffer: cached.buffer, metadata: cached.metadata };
      }
      this.wasmUrlCache.delete(resolvedUrl);
    }

    const initialUrl = new URL(resolvedUrl);
    await this.assertSafeWasmUrl(initialUrl);

    const configuredTimeout = this.configService.get<string>('WASM_URL_TIMEOUT_MS');
    const timeoutMs = configuredTimeout ? parseInt(configuredTimeout, 10) || 30000 : 30000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let currentUrl = initialUrl;
      let redirects = 0;
      let response: Response;

      for (;;) {
        response = await fetch(currentUrl, {
          signal: controller.signal,
          redirect: 'manual',
        });

        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || redirects >= WASM_URL_MAX_REDIRECTS) {
            break;
          }
          redirects += 1;
          void response.body?.cancel().catch(() => undefined);
          currentUrl = new URL(location, currentUrl);
          await this.assertSafeWasmUrl(currentUrl);
          continue;
        }
        break;
      }

      if (!response.ok) {
        throw new BadRequestException(
          `Failed to download WASM from URL: HTTP ${response.status}`,
        );
      }

      const contentLength = Number(response.headers.get('content-length') || '0');
      if (contentLength > this.maxFileSize) {
        throw new BadRequestException(
          `WASM file exceeds maximum size of ${this.maxFileSize / (1024 * 1024)}MB`,
        );
      }

      if (!response.body) {
        throw new BadRequestException('Failed to download WASM from URL: empty response body');
      }

      // response.body is the (auto-)decompressed stream, so the size limit is
      // enforced after decompression and across every redirect hop.
      const chunks: Buffer[] = [];
      let totalSize = 0;

      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        totalSize += chunk.byteLength;
        if (totalSize > this.maxFileSize) {
          controller.abort();
          throw new BadRequestException(
            `WASM file exceeds maximum size of ${this.maxFileSize / (1024 * 1024)}MB`,
          );
        }
        chunks.push(Buffer.from(chunk));
      }

      const wasmBuffer = Buffer.concat(chunks);

      if (
        wasmBuffer.length < 8 ||
        wasmBuffer.readUInt32LE(0) !== 0x6d736100 ||
        wasmBuffer.readUInt32LE(4) !== 1
      ) {
        throw new BadRequestException('Invalid WASM format');
      }

      const metadata = await this.storeUploadedWasm({
        wasmBuffer,
        filename: path.basename(new URL(resolvedUrl).pathname) || 'contract.wasm',
        source: 'url',
      });

      this.wasmUrlCache.set(resolvedUrl, { contentHash: metadata.contentHash, cachedAt: Date.now() });
      this.pruneUrlCache();

      return { buffer: wasmBuffer, metadata };
    } catch (err: any) {
      if (err instanceof BadRequestException) {
        throw err;
      }
      if (err.name === 'AbortError' || err.code === 'ABORT_ERR') {
        throw new BadRequestException('WASM download timed out');
      }
      throw new BadRequestException(`Failed to fetch WASM from URL: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveWasmUrl(url: string): string {
    if (url.startsWith('ipfs://')) {
      const ipfsPath = url.slice('ipfs://'.length);
      if (!ipfsPath) {
        throw new BadRequestException('Invalid IPFS URL');
      }
      const gateway = this.configService.get<string>('IPFS_GATEWAY_URL', 'https://ipfs.io');
      return `${gateway.replace(/\/$/, '')}/ipfs/${ipfsPath}`;
    }

    if (url.startsWith('ar://')) {
      const arweaveId = url.slice('ar://'.length);
      if (!arweaveId) {
        throw new BadRequestException('Invalid Arweave URL');
      }
      const gateway = this.configService.get<string>('ARWEAVE_GATEWAY_URL', 'https://arweave.net');
      return `${gateway.replace(/\/$/, '')}/${arweaveId}`;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('Invalid WASM URL');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Invalid WASM URL protocol');
    }

    return parsed.toString();
  }

  async deploy(
    wasmBuffer: Buffer | string,
    constructorArgs?: unknown[],
  ): Promise<{ contractId: string; wasmHash: string; txHash: string }> {
    if (typeof wasmBuffer === 'string') {
      wasmBuffer = (await this.fetchWasmFromUrl(wasmBuffer)).buffer;
    }
    if (!wasmBuffer || wasmBuffer.length === 0) {
      throw new BadRequestException("WASM file is empty");
    }

    if (wasmBuffer.length > this.maxFileSize) {
      throw new BadRequestException(`WASM file exceeds maximum size of ${this.maxFileSize / (1024 * 1024)}MB`);
    }

    const scVals: xdr.ScVal[] = (constructorArgs ?? []).map((arg) =>
      nativeToScVal(arg),
    );

    const wasmHashBytes = hash(wasmBuffer);

    this.logger.log(`Uploading WASM (${wasmBuffer.length} bytes)...`);
    await this.uploadWasm(wasmBuffer);

    this.logger.log(
      `Creating contract from WASM hash ${wasmHashBytes.toString("hex")}...`,
    );
    const salt = Keypair.random().xdrPublicKey().value();
    const contractId = this.computeContractId(salt);
    const createTxHash = await this.createContract(wasmHashBytes, salt, scVals);

    return {
      contractId,
      wasmHash: wasmHashBytes.toString("hex"),
      txHash: createTxHash,
    };
  }

  async uploadWasmOnly(wasmBuffer: Buffer): Promise<{ wasmHash: string; size: number }> {
    if (!wasmBuffer || wasmBuffer.length === 0) {
      throw new BadRequestException('WASM file is empty');
    }
    if (wasmBuffer.length > 1024 * 1024) {
      throw new BadRequestException('WASM file exceeds maximum size of 1MB');
    }

    // Check init auth / format basic validation (WASM magic header)
    if (wasmBuffer.length < 4 || wasmBuffer.readUInt32LE(0) !== 0x6d736100) {
      throw new BadRequestException('Invalid WASM format: missing magic header');
    }

    const wasmHashBytes = hash(wasmBuffer);
    await this.uploadWasm(wasmBuffer);
    return {
      wasmHash: wasmHashBytes.toString('hex'),
      size: wasmBuffer.length,
    };
  }

  async deployConfigured(params: {
    wasmBuffer: Buffer;
    admin?: string;
    salt?: string;
    constructorArgs?: unknown[];
  }): Promise<{ contractId: string; wasmHash: string; txHash: string }> {
    const { wasmBuffer, admin, salt: customSalt, constructorArgs } = params;
    if (!wasmBuffer || wasmBuffer.length === 0) {
      throw new BadRequestException('WASM file is empty');
    }

    const scVals: xdr.ScVal[] = (constructorArgs ?? []).map((arg) => nativeToScVal(arg));
    const wasmHashBytes = hash(wasmBuffer);

    await this.uploadWasm(wasmBuffer);

    let saltBuffer: Buffer;
    if (customSalt) {
      try {
        saltBuffer = Buffer.from(customSalt, 'hex');
        if (saltBuffer.length !== 32) {
          saltBuffer = Keypair.random().xdrPublicKey().value();
        }
      } catch {
        saltBuffer = Keypair.random().xdrPublicKey().value();
      }
    } else {
      saltBuffer = Keypair.random().xdrPublicKey().value();
    }

    const creatorAddress = admin && StrKey.isValidEd25519PublicKey(admin) ? new Address(admin) : new Address(this.deployer.publicKey());
    const contractId = this.computeContractIdWithAddress(creatorAddress, saltBuffer);
    const createTxHash = await this.createCustomContractWithAddress(creatorAddress, wasmHashBytes, saltBuffer, scVals);

    return {
      contractId,
      wasmHash: wasmHashBytes.toString('hex'),
      txHash: createTxHash,
    };
  }

  private async uploadWasm(wasmBuffer: Buffer): Promise<string> {
    const account = await this.timeRpc("get_account", () =>
      this.rpcServer.getAccount(this.deployer.publicKey()),
    );

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(Operation.uploadContractWasm({ wasm: wasmBuffer }))
      .setTimeout(30)
      .build();

    const prepared = await this.timeRpc("prepare_transaction", () =>
      this.rpcServer.prepareTransaction(tx),
    );
    prepared.sign(this.deployer);

    const sendResult = await this.timeRpc("send_transaction", () =>
      this.rpcServer.sendTransaction(prepared),
    );
    const result = await this.timeRpc("poll_transaction", () =>
      this.rpcServer.pollTransaction(sendResult.hash, {
        attempts: 30,
      }),
    );

    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new BadRequestException(
        `WASM upload failed: ${result.status === rpc.Api.GetTransactionStatus.FAILED ? "Transaction failed on ledger" : "Transaction not found after polling"}`,
      );
    }

    return sendResult.hash;
  }

  private computeContractId(salt: Buffer): string {
    const address = new Address(this.deployer.publicKey());
    const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({
        address: address.toScAddress(),
        salt: salt,
      }),
    );
    const preimageHash = hash(preimage.toXDR());
    return StrKey.encodeContract(preimageHash);
  }

  private computeContractIdWithAddress(address: Address, salt: Buffer): string {
    const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({
        address: address.toScAddress(),
        salt: salt,
      }),
    );
    const preimageHash = hash(preimage.toXDR());
    return StrKey.encodeContract(preimageHash);
  }

  private async createContract(
    wasmHash: Buffer,
    salt: Buffer,
    constructorArgs: xdr.ScVal[],
  ): Promise<string> {
    const account = await this.timeRpc("get_account", () =>
      this.rpcServer.getAccount(this.deployer.publicKey()),
    );
    const address = new Address(this.deployer.publicKey());
    return this.createCustomContractWithAddress(address, wasmHash, salt, constructorArgs);
  }

  private async createCustomContractWithAddress(
    address: Address,
    wasmHash: Buffer,
    salt: Buffer,
    constructorArgs: xdr.ScVal[],
  ): Promise<string> {
    const account = await this.rpcServer.getAccount(this.deployer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.createCustomContract({
          address,
          wasmHash,
          salt,
          constructorArgs,
        }),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.timeRpc("prepare_transaction", () =>
      this.rpcServer.prepareTransaction(tx),
    );
    prepared.sign(this.deployer);

    const sendResult = await this.timeRpc("send_transaction", () =>
      this.rpcServer.sendTransaction(prepared),
    );
    const result = await this.timeRpc("poll_transaction", () =>
      this.rpcServer.pollTransaction(sendResult.hash, {
        attempts: 30,
      }),
    );

    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new BadRequestException(
        `Contract creation failed: ${result.status === rpc.Api.GetTransactionStatus.FAILED ? "Transaction failed on ledger" : "Transaction not found after polling"}`,
      );
    }

    return sendResult.hash;
  }

  async invoke(
    contractId: string,
    functionName: string,
    args: unknown[],
  ): Promise<{ result: unknown; txHash: string }> {
    if (!StrKey.isValidContract(contractId)) {
      throw new BadRequestException("Invalid contract ID format");
    }

    this.assertInvocationAllowed(contractId, functionName);

    const scVals: xdr.ScVal[] = args.map((arg) => nativeToScVal(arg));
    const account = await this.timeRpc("get_account", () =>
      this.rpcServer.getAccount(this.deployer.publicKey()),
    );

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.invokeContractFunction({
          contract: contractId,
          function: functionName,
          args: scVals,
        }),
      )
      .setTimeout(30)
      .build();

    const prepared = await this.timeRpc("prepare_transaction", () =>
      this.rpcServer.prepareTransaction(tx),
    );
    prepared.sign(this.deployer);

    const sendResult = await this.timeRpc("send_transaction", () =>
      this.rpcServer.sendTransaction(prepared),
    );
    const result = await this.timeRpc("poll_transaction", () =>
      this.rpcServer.pollTransaction(sendResult.hash, {
        attempts: 30,
      }),
    );

    if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      this.metricsService?.recordContractInvocation(functionName, false);
      throw new BadRequestException(
        `Invocation failed: ${result.status === rpc.Api.GetTransactionStatus.FAILED ? "Transaction failed on ledger" : "Transaction not found after polling"}`,
      );
    }

    const returnValue = result.returnValue
      ? scValToNative(result.returnValue)
      : null;
    this.metricsService?.recordContractInvocation(functionName, true);

    return {
      result: returnValue,
      txHash: sendResult.hash,
    };
  }

  private assertInvocationAllowed(contractId: string, functionName: string): void {
    const allowedContractsRaw = this.configService.get<string>('CONTRACT_INVOKE_ALLOWED_CONTRACTS');
    const allowedFunctionsRaw = this.configService.get<string>('CONTRACT_INVOKE_ALLOWED_FUNCTIONS');

    if (!allowedContractsRaw || !allowedFunctionsRaw) {
      throw new ForbiddenException('Contract invocations are not permitted (allowlist not configured)');
    }

    const contractsList = allowedContractsRaw.split(',').map((c) => c.trim()).filter(Boolean);
    const functionsList = allowedFunctionsRaw.split(',').map((f) => f.trim()).filter(Boolean);

    if (!contractsList.includes(contractId) || !functionsList.includes(functionName)) {
      throw new ForbiddenException('Contract or function is not allowlisted for invocation');
    }
  }

  private parseAllowlist(configKey: string): string[] {
    const raw = this.configService.get<string>(configKey, "");
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  private timeRpc<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return this.metricsService
      ? this.metricsService.timeSorobanRpc(
          operation,
          this.configService.get<string>("STELLAR_NETWORK", "testnet"),
          fn,
        )
      : fn();
  }

  async getInfo(
    contractId: string,
  ): Promise<{ contractId: string; wasmHash: string; network: string }> {
    if (!StrKey.isValidContract(contractId)) {
      throw new BadRequestException("Invalid contract ID format");
    }

    const network = this.configService.get<string>('STELLAR_NETWORK', 'testnet');

    try {
      const wasm = await this.timeRpc("get_contract_wasm", () =>
        this.rpcServer.getContractWasmByContractId(contractId),
      );
      const wasmHash = wasm ? hash(wasm).toString("hex") : "";

      return {
        contractId,
        network,
        wasmHash,
      };
    } catch {
      throw new NotFoundException(`Contract ${contractId} not found on network ${network}`);
    }
  }

  // ─── Contract ABI catalog (Savitura/Savitools#219) ───────────────────────

  /**
   * Attach a validated ABI/interface document to a contract (and optionally a
   * WASM record). Storage is an in-process bounded registry — no new
   * migration is introduced (Savitura/Savitools#194 dependency).
   */
  attachAbi(contractId: string, dto: AttachAbiDto): AbiCatalogEntry {
    if (!contractId || contractId.length < 40) {
      throw new BadRequestException('contractId must be a Soroban contract ID');
    }

    if (Buffer.byteLength(JSON.stringify(dto.schema ?? {}), 'utf8') > ABI_MAX_BYTES) {
      throw new BadRequestException(
        `ABI document exceeds the maximum accepted size of ${ABI_MAX_BYTES} bytes`,
      );
    }

    const entry = buildAbiCatalog(contractId, dto.schema, {
      wasmId: dto.wasmId,
      network: dto.network ?? 'testnet',
      name: dto.name,
    });

    this.pruneAbiCatalogs();
    this.abiCatalogs.set(entry.id, {
      entry,
      expiresAt: Date.now() + ABI_CATALOG_TTL_MS,
    });

    return entry;
  }

  getAbi(contractId: string, wasmId?: string): AbiCatalogEntry {
    const id = `${contractId}:${wasmId ?? 'default'}`;
    const found = this.abiCatalogs.get(id);
    if (!found || found.expiresAt < Date.now()) {
      this.abiCatalogs.delete(id);
      throw new NotFoundException(
        `No ABI catalog attached to contract ${contractId}` +
          (wasmId ? ` / WASM ${wasmId}` : ''),
      );
    }
    return found.entry;
  }

  /** Encode declared arguments using the existing SCVal utilities. */
  encodeAbiArguments(
    contractId: string,
    functionName: string,
    args: unknown[],
    wasmId?: string,
  ): Array<{ name: string; type: string; xdrBase64: string; decoded: { type: string; value: unknown } }> {
    const entry = this.getAbi(contractId, wasmId);
    const method = entry.methods.find((m) => m.name === functionName);
    if (!method) {
      throw new NotFoundException(
        `Method '${functionName}' is not part of the ABI catalog for ${contractId}`,
      );
    }
    if (args.length !== method.arguments.length) {
      throw new BadRequestException(
        `Method '${functionName}' expects ${method.arguments.length} argument(s), received ${args.length}`,
      );
    }

    return method.arguments.map((arg, i) => {
      const encoded = encodeAbiArgument(arg.type, args[i]);
      return {
        name: arg.name,
        type: arg.type,
        xdrBase64: encoded.xdrBase64,
        decoded: encoded.decoded,
      };
    });
  }

  private pruneAbiCatalogs(): void {
    const now = Date.now();
    for (const [key, entry] of this.abiCatalogs) {
      if (entry.expiresAt < now) this.abiCatalogs.delete(key);
    }
    while (this.abiCatalogs.size > ABI_CATALOG_MAX_ENTRIES) {
      const oldest = this.abiCatalogs.keys().next().value;
      if (oldest === undefined) break;
      this.abiCatalogs.delete(oldest);
    }
  }
}
