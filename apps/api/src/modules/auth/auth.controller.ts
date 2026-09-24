import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { FastifyReply, FastifyRequest } from 'fastify';
import type { RedisClientType } from 'redis';
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_TTL_SECONDS,
} from './auth.constants';
import { AuthService } from './auth.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { FluxaDto } from './dto/fluxa.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { LoginDto } from './dto/login.dto';
import { PasskeyLoginVerifyDto, PasskeyReauthDto, PasskeyRegistrationVerifyDto, PasskeyRenameDto } from './dto/passkey.dto';
import { RegisterDto } from './dto/register.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from './guards/optional-jwt-auth.guard';

type AuthRequest = FastifyRequest & { user?: { id: string; email: string } };

function extractIp(req: FastifyRequest): string | undefined {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.ip;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    @Inject('REDIS_CLIENT')
    private readonly redis: RedisClientType,
  ) {}

  // ─── Registration ─────────────────────────────────────────────────────────

  @Post('register')
  @ApiOperation({ summary: 'Register with email and password' })
  @ApiResponse({ status: 201, description: 'Verification email sent' })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('verify-email')
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify email address and receive session tokens' })
  @ApiResponse({ status: 200, description: 'Email verified, tokens issued' })
  @ApiResponse({ status: 404, description: 'Invalid token' })
  @ApiResponse({ status: 410, description: 'TOKEN_EXPIRED' })
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { user, tokens } = await this.authService.verifyEmail(dto.token);
    this.setAuthCookies(reply, tokens.accessToken, tokens.refreshToken);
    return { user: { id: user.id, email: user.email, emailVerified: user.emailVerified } };
  }

  // ─── Login ────────────────────────────────────────────────────────────────

  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { user, tokens } = await this.authService.login(dto, {
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    this.setAuthCookies(reply, tokens.accessToken, tokens.refreshToken);
    return {
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        fluxaTenantId: user.fluxaTenantId,
      },
    };
  }

  // ─── Password reset (Savitura/Savitools#196) ──────────────────────────────

  @Post('forgot-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Request a password reset email (enumeration-resistant)' })
  @ApiResponse({ status: 200, description: 'Generic response, regardless of account existence' })
  @ApiResponse({ status: 429, description: 'Too many reset requests from this IP or email' })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() req: FastifyRequest,
  ) {
    return this.authService.requestPasswordReset(dto.email, extractIp(req));
  }

  @Post('reset-password')
  @HttpCode(200)
  @ApiOperation({ summary: 'Set a new password with a valid, unused, unexpired reset token' })
  @ApiResponse({ status: 200, description: 'Password updated; existing sessions revoked' })
  @ApiResponse({ status: 404, description: 'Invalid token' })
  @ApiResponse({ status: 410, description: 'RESET_TOKEN_EXPIRED' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.password);
  }

  // ─── Token rotation ───────────────────────────────────────────────────────

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate refresh token and issue new access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed' })
  @ApiResponse({ status: 401, description: 'INVALID_REFRESH_TOKEN' })
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (typeof refreshToken !== 'string') {
      this.clearAuthCookies(reply);
      return { authenticated: false };
    }

    const { user, tokens } = await this.authService.refresh(refreshToken, {
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    this.setAuthCookies(reply, tokens.accessToken, tokens.refreshToken);
    return {
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        fluxaTenantId: user.fluxaTenantId,
      },
    };
  }

  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Invalidate refresh token and clear auth cookies' })
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const refreshToken = req.cookies?.[REFRESH_TOKEN_COOKIE];
    if (typeof refreshToken === 'string') {
      await this.authService.logout(refreshToken);
    }
    this.clearAuthCookies(reply);
    return { success: true };
  }

  // ─── Session management ────────────────────────────────────────────────────

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List active sessions for the current user' })
  async listSessions(@CurrentUser() user: { id: string }) {
    const sessions = await this.authService.listSessions(user.id);
    return sessions.map((s) => ({
      id: s.id,
      ipAddress: s.ipAddress,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
    }));
  }

  @Delete('sessions/:id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Revoke a specific session by ID' })
  @ApiResponse({ status: 404, description: 'Session not found' })
  async revokeSession(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    await this.authService.revokeSession(id, user.id);
    return { success: true };
  }

  // ─── Fluxa OAuth (legacy direct-key link) ─────────────────────────────────

  @Post('fluxa')
  @HttpCode(200)
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Exchange a Fluxa API key for a SaviTools session' })
  async fluxa(
    @Body() dto: FluxaDto,
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const currentUser = req.user
      ? await this.authService.getUserById(req.user.id)
      : undefined;
    const { user, tokens } = await this.authService.fluxaLink(
      dto,
      currentUser ?? undefined,
      { ipAddress: extractIp(req), userAgent: req.headers['user-agent'] },
    );
    this.setAuthCookies(reply, tokens.accessToken, tokens.refreshToken);
    return {
      user: {
        id: user.id,
        email: user.email,
        fluxaTenantId: user.fluxaTenantId,
      },
    };
  }

  // ─── Connected accounts (OAuth flow) ──────────────────────────────────────

  @Get('connect')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List connected external accounts' })
  async listConnectedAccounts(@CurrentUser() user: { id: string }) {
    return this.authService.listConnectedAccounts(user.id);
  }

  @Post('connect/fluxa')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Begin Fluxa OAuth connection — returns redirect URL' })
  async beginFluxaConnect(@CurrentUser() user: { id: string }) {
    return this.authService.beginFluxaConnect(user.id, this.redis as unknown as {
      set: (key: string, value: string, options: { EX: number }) => Promise<unknown>;
    });
  }

  @Get('connect/fluxa/callback')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Fluxa OAuth callback — validates state, stores encrypted key' })
  @ApiResponse({ status: 400, description: 'Invalid or expired OAuth state' })
  async fluxaCallback(
    @Req() req: AuthRequest & { query: { code: string; state: string } },
  ) {
    const { code, state } = req.query;
    const account = await this.authService.completeFluxaConnect(
      code,
      state,
      this.redis as unknown as {
        get: (key: string) => Promise<string | null>;
        del: (key: string) => Promise<unknown>;
      },
    );
    return {
      id: account.id,
      provider: account.provider,
      connectedAt: account.connectedAt,
    };
  }

  @Delete('connect/:provider')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Disconnect a provider and remove stored credential' })
  @ApiResponse({ status: 404, description: 'Provider not connected' })
  async disconnectProvider(
    @Param('provider') provider: string,
    @CurrentUser() user: { id: string },
  ) {
    await this.authService.disconnectProvider(user.id, provider);
    return { success: true };
  }

  // ─── Me ───────────────────────────────────────────────────────────────────

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get the current authenticated user' })
  async me(@CurrentUser() user: { id: string; email: string }) {
    const record = await this.authService.getUserById(user.id);
    return {
      user: record
        ? {
            id: record.id,
            email: record.email,
            emailVerified: record.emailVerified,
            fluxaTenantId: record.fluxaTenantId,
          }
        : null,
    };
  }

  // ─── Passkeys (Savitura/Savitools#218) ────────────────────────────────────

  @Post('reauthenticate')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      'Reauthenticate with a password to mint a short-lived grant for passkey management',
  })
  @ApiResponse({ status: 200, description: 'Reauthentication grant issued' })
  @ApiResponse({ status: 401, description: 'Invalid password' })
  async reauthenticate(
    @CurrentUser() user: { id: string },
    @Body() dto: PasskeyReauthDto,
  ) {
    return this.authService.requestPasskeyReauth(user.id, dto.password);
  }

  @Post('passkeys/register/options')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Begin passkey registration (requires a reauthentication grant)' })
  async beginPasskeyRegistration(
    @CurrentUser() user: { id: string },
    @Body() dto: { reauthToken: string },
  ) {
    return this.authService.beginPasskeyRegistration(user.id, dto.reauthToken);
  }

  @Post('passkeys/register')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Verify an attestation and store the new passkey credential' })
  async verifyPasskeyRegistration(
    @CurrentUser() user: { id: string },
    @Body() dto: PasskeyRegistrationVerifyDto,
  ) {
    const credential = await this.authService.verifyPasskeyRegistration(
      user.id,
      dto.reauthToken,
      dto.name,
      dto.registrationResponse as never,
      dto.transports,
    );
    return {
      passkey: {
        id: credential.id,
        name: credential.name,
        createdAt: credential.createdAt,
      },
    };
  }

  @Post('passkeys/login/options')
  @HttpCode(200)
  @ApiOperation({ summary: 'Begin passkey assertion login' })
  async beginPasskeyLogin(@Body() dto: { email?: string }) {
    return this.authService.beginPasskeyLogin(dto.email);
  }

  @Post('passkeys/login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify an assertion and receive the same access/refresh cookie session as password login',
  })
  async verifyPasskeyLogin(
    @Body() dto: PasskeyLoginVerifyDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { user, tokens } = await this.authService.verifyPasskeyLogin(
      dto.assertionResponse as never,
      {
        ipAddress: extractIp(req),
        userAgent: req.headers['user-agent'],
      },
    );
    this.setAuthCookies(reply, tokens.accessToken, tokens.refreshToken);
    return {
      user: {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        fluxaTenantId: user.fluxaTenantId,
      },
    };
  }

  @Get('passkeys')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List passkeys registered for the current account' })
  async listPasskeys(@CurrentUser() user: { id: string }) {
    return this.authService.listPasskeys(user.id);
  }

  @Patch('passkeys/:id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Rename a passkey (requires a reauthentication grant)' })
  async renamePasskey(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: PasskeyRenameDto & { reauthToken: string },
  ) {
    await this.authService.renamePasskey(id, user.id, dto.name, dto.reauthToken);
    return { success: true };
  }

  @Delete('passkeys/:id')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Revoke a passkey; revoked credentials can never authenticate (requires a reauthentication grant)' })
  async revokePasskey(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body() dto: { reauthToken: string },
  ) {
    await this.authService.revokePasskey(id, user.id, dto.reauthToken);
    return { success: true };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private setAuthCookies(
    reply: FastifyReply,
    accessToken: string,
    refreshToken: string,
  ): void {
    const isProduction =
      this.configService.get<string>('NODE_ENV') === 'production';
    const cookieOptions = {
      httpOnly: true,
      secure: isProduction,
      sameSite: 'lax' as const,
      path: '/',
    };

    reply.setCookie(ACCESS_TOKEN_COOKIE, accessToken, {
      ...cookieOptions,
      maxAge: ACCESS_TOKEN_TTL_SECONDS,
    });

    reply.setCookie(REFRESH_TOKEN_COOKIE, refreshToken, {
      ...cookieOptions,
      maxAge: REFRESH_TOKEN_TTL_SECONDS,
    });
  }

  private clearAuthCookies(reply: FastifyReply): void {
    reply.clearCookie(ACCESS_TOKEN_COOKIE, { path: '/' });
    reply.clearCookie(REFRESH_TOKEN_COOKIE, { path: '/' });
  }
}
