import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { FederationService } from './federation.service';
import { ResolveQueryDto } from './dto/resolve-query.dto';
import { TomlQueryDto } from './dto/toml-query.dto';
import { SepQueryDto } from './dto/sep-query.dto';
import { LinkPreviewQueryDto } from './dto/link-preview-query.dto';

@ApiTags('federation')
@Controller('federation')
export class FederationController {
  constructor(private readonly federationService: FederationService) {}

  @Get('resolve')
  @ApiOperation({
    summary: 'Resolve a Stellar address, federation address, or domain',
  })
  @ApiQuery({
    name: 'address',
    description: 'Stellar public key (G…), federation address, or domain',
    example: 'alice*stellar.org',
  })
  resolve(@Query() query: ResolveQueryDto) {
    return this.federationService.resolveFederation(query.address);
  }

  @Get('toml')
  @ApiOperation({ summary: "Fetch and parse a domain's stellar.toml" })
  @ApiQuery({
    name: 'domain',
    description: 'Domain to fetch stellar.toml from',
    example: 'stellar.org',
  })
  getToml(@Query() query: TomlQueryDto) {
    return this.federationService.getToml(query.domain);
  }

  @Get('sep')
  @ApiOperation({
    summary: 'Determine which SEPs an anchor supports',
  })
  @ApiQuery({
    name: 'domain',
    description: 'Domain to inspect for SEP support',
    example: 'stellar.org',
  })
  getSepSupport(@Query() query: SepQueryDto) {
    return this.federationService.getSepSupport(query.domain);
  }

  @Get('link-preview')
  @ApiOperation({
    summary:
      'Build a copyable SEP-6/24/31 transfer request link from stellar.toml (never signed or submitted)',
  })
  getLinkPreview(@Query() query: LinkPreviewQueryDto) {
    return this.federationService.buildTransferRequestLink(query.domain, {
      sep: query.sep,
      asset: query.asset,
      amount: query.amount,
      memo: query.memo,
      callback: query.callback,
      account: query.account,
    });
  }
}
