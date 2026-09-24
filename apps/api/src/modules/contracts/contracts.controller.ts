import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Req,
  BadRequestException,
  UnprocessableEntityException,
  UseGuards,
  Inject,
  Optional,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags, ApiConsumes, ApiResponse, ApiParam } from '@nestjs/swagger';
import { FastifyRequest } from 'fastify';
import { ContractsService } from './contracts.service';
import { InvokeContractDto } from './dto/invoke-contract.dto';
import { DeployContractDto } from './dto/deploy-contract.dto';
import { DeployWizardDto } from './dto/wizard.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ContractAuthorizationGuard } from './guards/contract-authorization.guard';
import * as crypto from 'crypto';

@ApiTags('contracts')
@Controller('contracts')
export class ContractsController {
  private static wizardSessions = new Map<string, { lastStep: number; wasmBuffer?: Buffer; admin?: string; salt?: string; args?: unknown[]; expiresAt: number }>();

  constructor(private readonly contractsService: ContractsService) {}

  @Post('deploy')
  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard, ContractAuthorizationGuard)
  @ApiOperation({ summary: 'Deploy a Soroban smart contract from a WASM file' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 200, description: 'Contract deployed successfully' })
  @ApiResponse({ status: 400, description: 'Invalid WASM file or parameters' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Not authorized to deploy contracts' })
  async deploy(@Req() req: FastifyRequest) {
    let file;
    try {
      file = await req.file();
    } catch {
      file = undefined;
    }

    if (file) {
      const mimetype = file.mimetype;
      if (mimetype !== 'application/wasm' && mimetype !== 'application/octet-stream' && !file.filename.endsWith('.wasm')) {
        throw new BadRequestException('Uploaded file must be a .wasm file');
      }
      const wasmBuffer = await file.toBuffer();
      const argsField = file.fields.args as { value?: string } | undefined;
      const constructorArgs: unknown[] | undefined = argsField?.value
        ? this.parseArgs(argsField.value)
        : undefined;
      return this.contractsService.deploy(wasmBuffer, constructorArgs);
    }

    const body = (req.body ?? {}) as { wasm_url?: string; wasmUrl?: string; args?: string };
    const wasmUrl = body.wasm_url ?? body.wasmUrl;
    if (!wasmUrl) {
      throw new BadRequestException('WASM file or wasm_url is required');
    }

    const { buffer: wasmBuffer } = await this.contractsService.fetchWasmFromUrl(wasmUrl);
    const constructorArgs: unknown[] | undefined = body.args ? this.parseArgs(body.args) : undefined;
    return this.contractsService.deploy(wasmBuffer, constructorArgs);
  }

  @Post('deploy/wizard')
  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard, ContractAuthorizationGuard)
  @ApiOperation({ summary: 'Soroban contract deployment wizard with step validation' })
  @ApiResponse({ status: 200, description: 'Wizard step processed successfully' })
  @ApiResponse({ status: 400, description: 'Validation failed or out of order step' })
  async deployWizard(@Req() req: FastifyRequest, @Body() dto: DeployWizardDto) {
    const now = Date.now();
    // Clean expired sessions
    for (const [k, v] of ContractsController.wizardSessions.entries()) {
      if (v.expiresAt < now) {
        ContractsController.wizardSessions.delete(k);
      }
    }

    const ttl = 3600 * 1000; // 1-hour TTL

    if (dto.step === 1) {
      let wasmBuffer: Buffer;
      if (dto.wasmBase64) {
        wasmBuffer = Buffer.from(dto.wasmBase64, 'base64');
      } else {
        // Check if multipart file is provided in request
        try {
          const file = await req.file();
          if (file) {
            wasmBuffer = await file.toBuffer();
          } else {
            throw new BadRequestException('WASM file or wasmBase64 is required for Step 1');
          }
        } catch {
          throw new BadRequestException('WASM file or wasmBase64 is required for Step 1');
        }
      }

      if (wasmBuffer.length === 0) {
        throw new BadRequestException('WASM file is empty');
      }
      if (wasmBuffer.length > 1024 * 1024) {
        throw new BadRequestException('WASM file exceeds 1MB limit');
      }

      // Validate WASM magic header and init auth check
      if (wasmBuffer.length < 4 || wasmBuffer.readUInt32LE(0) !== 0x6d736100) {
        throw new BadRequestException('Invalid WASM format: missing magic header');
      }

      const stepToken = crypto.randomBytes(32).toString('hex');
      ContractsController.wizardSessions.set(stepToken, {
        lastStep: 1,
        wasmBuffer,
        expiresAt: now + ttl,
      });

      return {
        step: 1,
        status: 'success',
        message: 'WASM uploaded and validated successfully',
        stepToken,
      };
    }

    if (dto.step === 2) {
      if (!dto.stepToken) {
        throw new BadRequestException('Step token is required for Step 2');
      }
      const session = ContractsController.wizardSessions.get(dto.stepToken);
      if (!session || session.expiresAt < now) {
        throw new BadRequestException('Invalid or expired step token');
      }
      if (session.lastStep < 1) {
        throw new BadRequestException('Out-of-order execution: Step 1 must be completed first');
      }

      // Configure parameters validation
      let parsedArgs: unknown[] | undefined;
      if (dto.args) {
        if (typeof dto.args === 'string') {
          parsedArgs = this.parseArgs(dto.args);
        } else if (Array.isArray(dto.args)) {
          parsedArgs = dto.args;
        } else {
          throw new BadRequestException('Constructor args must be a JSON array');
        }
      }

      session.admin = dto.admin;
      session.salt = dto.salt;
      session.args = parsedArgs;
      session.lastStep = 2;
      session.expiresAt = now + ttl;

      const nextStepToken = crypto.randomBytes(32).toString('hex');
      ContractsController.wizardSessions.set(nextStepToken, session);
      ContractsController.wizardSessions.delete(dto.stepToken);

      return {
        step: 2,
        status: 'success',
        message: 'Contract parameters configured and validated',
        stepToken: nextStepToken,
      };
    }

    if (dto.step === 3) {
      if (!dto.stepToken) {
        throw new BadRequestException('Step token is required for Step 3');
      }
      const session = ContractsController.wizardSessions.get(dto.stepToken);
      if (!session || session.expiresAt < now) {
        throw new BadRequestException('Invalid or expired step token');
      }
      if (session.lastStep < 2) {
        throw new BadRequestException('Out-of-order execution: Step 2 must be completed first');
      }
      if (!session.wasmBuffer) {
        throw new BadRequestException('WASM buffer missing from session state');
      }

      const result = await this.contractsService.deployConfigured({
        wasmBuffer: session.wasmBuffer,
        admin: session.admin,
        salt: session.salt,
        constructorArgs: session.args,
      });

      ContractsController.wizardSessions.delete(dto.stepToken);

      return {
        step: 3,
        status: 'success',
        message: 'Contract deployed and verified on-chain successfully',
        contractAddress: result.contractId,
        contractId: result.contractId,
        wasmHash: result.wasmHash,
        txHash: result.txHash,
      };
    }

    throw new BadRequestException('Invalid wizard step');
  @Post('wasm/upload')
  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard, ContractAuthorizationGuard)
  @ApiOperation({ summary: 'Upload and pin Soroban contract WASM from local file or Git repo with integrity verification' })
  @ApiConsumes('multipart/form-data')
  @ApiResponse({ status: 201, description: 'WASM uploaded and pinned successfully' })
  @ApiResponse({ status: 400, description: 'Invalid request or file' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Not authorized' })
  @ApiResponse({ status: 422, description: 'SHA-256 checksum verification failed' })
  async uploadWasm(@Req() req: FastifyRequest) {
    const file = await req.file();
    const fields = file ? file.fields : (req.body as any) || {};

    let wasmBuffer: Buffer;
    let filename = 'contract.wasm';

    const checksumField = (fields.checksum as { value?: string })?.value || (req.body as any)?.checksum;
    const gitRepoUrl = (fields.gitRepoUrl as { value?: string })?.value || (req.body as any)?.gitRepoUrl;
    const gitArtifactPath = (fields.gitArtifactPath as { value?: string })?.value || (req.body as any)?.gitArtifactPath;

    if (gitRepoUrl) {
      if (!gitArtifactPath) {
        throw new BadRequestException('gitArtifactPath is required when gitRepoUrl is provided');
      }
      wasmBuffer = await this.contractsService.fetchWasmFromGit(gitRepoUrl, gitArtifactPath);
      filename = gitArtifactPath.split('/').pop() || 'contract.wasm';
    } else if (file) {
      filename = file.filename || 'contract.wasm';
      if (!filename.endsWith('.wasm') && file.mimetype !== 'application/wasm' && file.mimetype !== 'application/octet-stream') {
        throw new BadRequestException('Uploaded file must be a .wasm file');
      }
      wasmBuffer = await file.toBuffer();
    } else {
      throw new BadRequestException('Either a .wasm file or a gitRepoUrl is required');
    }

    return this.contractsService.storeUploadedWasm({
      wasmBuffer,
      filename,
      checksum: typeof checksumField === 'string' ? checksumField : undefined,
      source: gitRepoUrl ? 'git' : 'file',
    });
  }

  @Post(':contractId/invoke')
  @ApiCookieAuth()
  @UseGuards(JwtAuthGuard, ContractAuthorizationGuard)
  @ApiOperation({ summary: 'Invoke a contract function' })
  @ApiParam({ name: 'contractId', description: 'Contract ID' })
  @ApiResponse({ status: 200, description: 'Contract function invoked successfully' })
  @ApiResponse({ status: 400, description: 'Invalid contract ID or parameters' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Not authorized to invoke this function' })
  async invoke(
    @Param('contractId') contractId: string,
    @Body() dto: InvokeContractDto,
  ) {
    return this.contractsService.invoke(contractId, dto.functionName, dto.args);
  }

  @Get(':contractId/info')
  @ApiOperation({ summary: 'Get contract metadata from the network' })
  @ApiParam({ name: 'contractId', description: 'Contract ID' })
  @ApiResponse({ status: 200, description: 'Contract information retrieved' })
  @ApiResponse({ status: 404, description: 'Contract not found' })
  async getInfo(@Param('contractId') contractId: string) {
    return this.contractsService.getInfo(contractId);
  }

  private parseArgs(raw: string): unknown[] {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new BadRequestException('Constructor args must be a JSON array');
      }
      return parsed;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Invalid JSON in args field');
    }
  }
}
