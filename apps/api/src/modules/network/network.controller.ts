import { Controller, Get, Query, Post, Body, Param, Put, Delete, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags, ApiResponse } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { NetworkService } from './network.service';

@ApiTags('network')
@Controller('network')
export class NetworkController {
  constructor(private readonly networkService: NetworkService) {}

  @Get('status')
  @ApiOperation({ summary: 'Get current Stellar network status and fees' })
  @ApiQuery({ name: 'network', required: false, enum: ['mainnet', 'testnet'], description: 'Network to query (default: mainnet)' })
  @ApiResponse({ status: 200, description: 'Network status retrieved' })
  async getStatus(@Query('network') network: string = 'mainnet') {
    const net = network === 'testnet' ? 'testnet' : 'mainnet';
    return this.networkService.fetchCurrentStatus(net);
  }

  @Get('status/history')
  @ApiOperation({ summary: 'Get network status history and uptime metrics' })
  @ApiQuery({ name: 'network', required: false, enum: ['mainnet', 'testnet'], description: 'Network to query (default: mainnet)' })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date lower bound (default: 60 minutes before to)' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date upper bound (default: now)' })
  @ApiResponse({ status: 200, description: 'Network status history retrieved' })
  async getHistory(
    @Query('network') network: string = 'mainnet',
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const net = network === 'testnet' ? 'testnet' : 'mainnet';
    return this.networkService.getHistory(net, from, to);
  }

  @Get('profiles')
  @ApiOperation({ summary: 'List network profiles for the authenticated user' })
  @ApiResponse({ status: 200, description: 'List of profiles returned' })
  listProfiles(@CurrentUser() user: { id: string }) {
    return this.networkService.listNetworkProfiles(user.id);
  }

  @Post('profiles')
  @ApiOperation({ summary: 'Create a new network profile' })
  @ApiResponse({ status: 201, description: 'Profile created' })
  createProfile(
    @CurrentUser() user: { id: string },
    @Body()
    body: {
      name: string;
      horizonUrl: string;
      networkPassphrase: string;
      friendbotUrl?: string;
      isDefault?: boolean;
    },
  ) {
    return this.networkService.createNetworkProfile(user.id, body);
  }

  @Put('profiles/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a network profile' })
  @ApiResponse({ status: 200, description: 'Profile updated' })
  updateProfile(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
    @Body()
    body: {
      name?: string;
      horizonUrl?: string;
      networkPassphrase?: string;
      friendbotUrl?: string;
      isDefault?: boolean;
    },
  ) {
    return this.networkService.updateNetworkProfile(user.id, id, body);
  }

  @Delete('profiles/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a network profile' })
  @ApiResponse({ status: 200, description: 'Profile deleted' })
  async deleteProfile(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    await this.networkService.deleteNetworkProfile(user.id, id);
    return { success: true };
  }

  @Post('profiles/:id/select')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Select a profile and apply it as the active network configuration' })
  @ApiResponse({ status: 200, description: 'Profile selected and verified' })
  @ApiResponse({ status: 409, description: 'Passphrase mismatch warning' })
  async selectProfile(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    const profile = await this.networkService.getNetworkProfile(user.id, id);
    const verification = await this.networkService.verifyNetworkPassphrase(
      profile.horizonUrl,
      profile.networkPassphrase,
    );
    return { profile, verification };
  }

  @Post('profiles/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify a Horizon URL network passphrase' })
  @ApiResponse({ status: 200, description: 'Verification result' })
  verifyPassphrase(
    @Body() body: { horizonUrl: string; expectedPassphrase?: string },
  ) {
    return this.networkService.verifyNetworkPassphrase(
      body.horizonUrl,
      body.expectedPassphrase ?? '',
    );
  }

  @Put('profiles/:id/default')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a profile as the default for startup' })
  @ApiResponse({ status: 200, description: 'Profile marked as default' })
  setDefaultProfile(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.networkService.setDefaultNetworkProfile(user.id, id);
  }

  @Get('profiles/:id/export')
  @ApiOperation({ summary: 'Export a profile as JSON' })
  @ApiResponse({ status: 200, description: 'Profile exported as JSON' })
  exportProfile(
    @Param('id') id: string,
    @CurrentUser() user: { id: string },
  ) {
    return this.networkService.exportNetworkProfile(user.id, id);
  }

  @Post('profiles/import')
  @ApiOperation({ summary: 'Import a network profile from JSON' })
  @ApiResponse({ status: 201, description: 'Profile imported' })
  importProfile(
    @CurrentUser() user: { id: string },
    @Body()
    body: {
      name: string;
      horizonUrl: string;
      networkPassphrase: string;
      friendbotUrl?: string;
      isDefault?: boolean;
    },
  ) {
    return this.networkService.importNetworkProfile(user.id, body);
  }
}
