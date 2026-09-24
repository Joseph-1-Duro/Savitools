import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  BadGatewayException,
  PayloadTooLargeException,
} from '@nestjs/common';
import * as smolToml from 'smol-toml';
import { assertPublicHostname, MAX_PROXY_REDIRECTS } from '../playground/ssrf-guard';

const FETCH_TIMEOUT = 15_000;

// ─── TOML input bounds (Savitura/Savitools#220) ──────────────────────────────
/** Maximum stellar.toml response size accepted before parsing. */
export const TOML_MAX_BYTES = 512 * 1024;
/** Maximum nesting depth of the parsed document. */
export const TOML_MAX_DEPTH = 64;
/** Hard cap on keys produced by a single document. */
export const TOML_MAX_KEYS = 10_000;

function isPublicKey(input: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(input);
}

function isFederationAddress(input: string): boolean {
  return /^[^\s*]+[*][^\s*]+\.[^\s*]+$/.test(input);
}

function isDomain(input: string): boolean {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(
    input,
  );
}

function stripProtocol(domain: string): string {
  return domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

export interface FederationResolveResult {
  stellarAddress: string | null;
  federationAddress: string | null;
  memo: string | null;
  memoType: string | null;
  homeDomain: string | null;
}

export interface TomlAccount {
  PUBLIC_KEY: string;
  NAME?: string;
  HOME_DOMAIN?: string;
  DESCRIPTION?: string;
}

export interface TomlCurrency {
  code: string;
  issuer: string;
  display_decimals?: number;
  name?: string;
  desc?: string;
  conditions?: string;
  image?: string;
  anchor_asset_type?: string;
  anchor_asset?: string;
  redemption_instructions?: string;
  collateral_addresses?: string;
  regulated?: boolean;
  approval_server?: string;
  approval_criteria?: string;
}

export interface TomlValidator {
  PUBLIC_KEY: string;
  NAME?: string;
  HOST?: string;
  HISTORY_URL?: string;
}

export interface TomlDocumentation {
  PRINCIPALS_NAME?: string;
  PRINCIPAL_EMAIL?: string;
  PROJECT_URL?: string;
  OFFICIAL_CHAT?: string;
  OTHER_INFO?: string;
}

export interface TomlResult {
  version: string | null;
  networkPassphrase: string | null;
  federationServer: string | null;
  transferServer: string | null;
  transferServerSep0024: string | null;
  webAuthEndpoint: string | null;
  directPaymentServer: string | null;
  accounts: TomlAccount[];
  currencies: TomlCurrency[];
  validators: TomlValidator[];
  documentation: TomlDocumentation | null;
  fetchLatencyMs: number;
  validationWarnings: string[];
}

export interface SepInfo {
  number: number;
  name: string;
  supported: boolean;
  endpoint: string | null;
  probeStatus: 'green' | 'yellow' | 'red' | 'none';
}

export interface SepResult {
  seps: SepInfo[];
}

// ─── Transfer request links (Savitura/Savitools#217) ────────────────────────

export type TransferRequestSep = '6' | '24' | '31';

export interface TransferLinkParams {
  sep: TransferRequestSep;
  asset: string;
  amount: string;
  memo?: string;
  callback?: string;
  account?: string;
  type?: 'deposit' | 'withdraw';
}

export interface TransferLinkResult {
  sep: TransferRequestSep;
  endpoint: string;
  url: string;
  asset: string;
  amount: string;
  warning: string;
}

const PUBLIC_KEY_RE = /^G[A-Z2-7]{55}$/;
/** Decimal string only — never routed through Number to avoid float conversion. */
const DECIMAL_STRING_RE = /^\d+(\.\d+)?$/;
const HTTPS_URL_RE = /^https:\/\/[^\s]+$/i;

const REQUIRED_TOML_FIELDS = ['ACCOUNTS'] as const;

/**
 * Bounded TOML parsing for remote stellar.toml content (Savitura/Savitools#220).
 *
 * smol-toml is a maintained parser without prototype-pollution or
 * uncontrolled-recursion behavior; the guards here cap input size, nesting
 * depth, and allocation before any parsed data is returned.
 */
function measureDepth(value: unknown, depth = 0): number {
  if (depth > TOML_MAX_DEPTH) return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value) max = Math.max(max, measureDepth(item, depth + 1));
    return max;
  }
  if (value && typeof value === 'object') {
    let max = depth;
    for (const item of Object.values(value)) max = Math.max(max, measureDepth(item, depth + 1));
    return max;
  }
  return depth;
}

function countKeys(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, item) => sum + countKeys(item), 0);
  }
  let count = 0;
  for (const item of Object.values(value)) count += 1 + countKeys(item);
  return count;
}

function parseBoundedToml(raw: string): Record<string, unknown> {
  if (Buffer.byteLength(raw, 'utf8') > TOML_MAX_BYTES) {
    throw new PayloadTooLargeException(
      `stellar.toml exceeds the maximum accepted size of ${TOML_MAX_BYTES} bytes`,
    );
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = smolToml.parse(raw) as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown parse error';
    throw new BadRequestException(`Malformed TOML document: ${msg}`);
  }

  const depth = measureDepth(parsed);
  if (depth >= TOML_MAX_DEPTH) {
    throw new BadRequestException(
      `TOML document nesting depth exceeds the limit of ${TOML_MAX_DEPTH}`,
    );
  }

  if (countKeys(parsed) > TOML_MAX_KEYS) {
    throw new BadRequestException(
      `TOML document exceeds the maximum of ${TOML_MAX_KEYS} keys`,
    );
  }

  return parsed;
}

@Injectable()
export class FederationService {
  private readonly logger = new Logger(FederationService.name);

  private async fetchWithTimeout(
    urlStr: string,
    timeout = FETCH_TIMEOUT,
  ): Promise<Response> {
    let target = new URL(urlStr);
    
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      throw new BadRequestException(`Unsupported protocol: ${target.protocol}`);
    }

    await assertPublicHostname(target.hostname);

    const requestInit = {
      signal: AbortSignal.timeout(timeout),
      headers: { Accept: '*/*' },
      redirect: 'manual' as const,
    };

    let response = await fetch(target.toString(), requestInit);
    let hops = 0;

    while ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has('location')) {
      if (++hops > MAX_PROXY_REDIRECTS) {
        throw new BadGatewayException('Too many redirects');
      }
      target = new URL(response.headers.get('location')!, target);
      if (target.protocol !== 'https:' && target.protocol !== 'http:') {
        throw new BadRequestException(`Unsupported protocol in redirect: ${target.protocol}`);
      }
      await assertPublicHostname(target.hostname);

      response = await fetch(target.toString(), requestInit);
    }

    return response;
  }

  private extractHomeDomain(
    federationRecord: Record<string, unknown>,
  ): string | null {
    const domain = federationRecord.home_domain;
    if (typeof domain === 'string') return domain;
    return null;
  }

  // ─── GET /federation/resolve ────────────────────────────────────────────

  async resolveFederation(
    address: string,
  ): Promise<FederationResolveResult> {
    const input = address.trim();

    if (isPublicKey(input)) {
      return this.reverseLookup(input);
    }

    if (isFederationAddress(input)) {
      return this.nameLookup(input);
    }

    const stripped = stripProtocol(input);
    if (isDomain(stripped)) {
      return this.domainLookup(stripped);
    }

    throw new BadRequestException(
      'Input must be a Stellar public key (G…), a federation address (user*domain), or a domain.',
    );
  }

  private async reverseLookup(
    publicKey: string,
  ): Promise<FederationResolveResult> {
    try {
      const url = `https://federation.stellar.org/federation?q=${encodeURIComponent(publicKey)}&type=id`;
      const res = await this.fetchWithTimeout(url);
      if (!res.ok) {
        throw new NotFoundException(
          `No federation record found for public key ${publicKey}`,
        );
      }
      const data = (await res.json()) as Record<string, unknown>;
      return {
        stellarAddress: publicKey,
        federationAddress: (data.stellar_address as string) ?? null,
        memo: (data.memo as string) ?? null,
        memoType: (data.memo_type as string) ?? null,
        homeDomain: this.extractHomeDomain(data),
      };
    } catch (err: unknown) {
      if (err instanceof NotFoundException) throw err;
      const msg = err instanceof Error ? err.message : 'Unknown error';
      throw new BadRequestException(
        `Federation reverse lookup failed: ${msg}`,
      );
    }
  }

  private async nameLookup(
    federationAddress: string,
  ): Promise<FederationResolveResult> {
    try {
      const url = `https://federation.stellar.org/federation?q=${encodeURIComponent(federationAddress)}&type=name`;
      const res = await this.fetchWithTimeout(url);
      if (!res.ok) {
        throw new NotFoundException(
          `No federation record found for ${federationAddress}`,
        );
      }
      const data = (await res.json()) as Record<string, unknown>;
      return {
        stellarAddress: (data.stellar_address as string) ?? null,
        federationAddress,
        memo: (data.memo as string) ?? null,
        memoType: (data.memo_type as string) ?? null,
        homeDomain: this.extractHomeDomain(data),
      };
    } catch (err: unknown) {
      if (err instanceof NotFoundException) throw err;
      const msg = err instanceof Error ? err.message : 'Unknown error';
      throw new BadRequestException(`Federation name lookup failed: ${msg}`);
    }
  }

  private async domainLookup(
    domain: string,
  ): Promise<FederationResolveResult> {
    const tomlData = await this.fetchToml(domain);
    if (!tomlData.FEDERATION_SERVER) {
      throw new NotFoundException(
        `Domain ${domain} does not declare a FEDERATION_SERVER in its stellar.toml`,
      );
    }

    return {
      stellarAddress: null,
      federationAddress: null,
      memo: null,
      memoType: null,
      homeDomain: domain,
    };
  }

  // ─── GET /federation/toml ───────────────────────────────────────────────

  async getToml(domain: string): Promise<TomlResult> {
    const cleanDomain = stripProtocol(domain.trim());
    if (!isDomain(cleanDomain)) {
      throw new BadRequestException(`Invalid domain: ${domain}`);
    }

    const start = Date.now();
    let rawToml: string;
    try {
      const url = `https://${cleanDomain}/.well-known/stellar.toml`;
      const res = await this.fetchWithTimeout(url);
      if (!res.ok) {
        throw new NotFoundException(
          `stellar.toml not found at ${url} (HTTP ${res.status})`,
        );
      }
      rawToml = await res.text();
    } catch (err: unknown) {
      if (err instanceof NotFoundException) throw err;
      const msg = err instanceof Error ? err.message : 'Unknown error';
      throw new BadRequestException(
        `Failed to fetch stellar.toml for ${cleanDomain}: ${msg}`,
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseBoundedToml(rawToml);
    } catch (err: unknown) {
      if (
        err instanceof BadRequestException ||
        err instanceof PayloadTooLargeException
      ) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : 'Unknown parse error';
      throw new BadRequestException(
        `Failed to parse stellar.toml for ${cleanDomain}: ${msg}`,
      );
    }

    const latencyMs = Date.now() - start;

    const validationWarnings: string[] = [];
    for (const field of REQUIRED_TOML_FIELDS) {
      if (!parsed[field]) {
        validationWarnings.push(
          `Missing required SEP-1 field: ${field}`,
        );
      }
    }

    return {
      version: (parsed.VERSION as string) ?? null,
      networkPassphrase: (parsed.NETWORK_PASSPHRASE as string) ?? null,
      federationServer: (parsed.FEDERATION_SERVER as string) ?? null,
      transferServer: (parsed.TRANSFER_SERVER as string) ?? null,
      transferServerSep0024:
        (parsed.TRANSFER_SERVER_SEP0024 as string) ?? null,
      webAuthEndpoint: (parsed.WEB_AUTH_ENDPOINT as string) ?? null,
      directPaymentServer:
        (parsed.DIRECT_PAYMENT_SERVER as string) ?? null,
      accounts: Array.isArray(parsed.ACCOUNTS)
        ? (parsed.ACCOUNTS as Record<string, unknown>[]).map((a) => ({
            PUBLIC_KEY: String(a.PUBLIC_KEY ?? ''),
            NAME: a.NAME ? String(a.NAME) : undefined,
            HOME_DOMAIN: a.HOME_DOMAIN
              ? String(a.HOME_DOMAIN)
              : undefined,
            DESCRIPTION: a.DESCRIPTION
              ? String(a.DESCRIPTION)
              : undefined,
          }))
        : [],
      currencies: Array.isArray(parsed.CURRENCIES)
        ? (parsed.CURRENCIES as Record<string, unknown>[]).map((c) => ({
            code: String(c.CODE ?? ''),
            issuer: String(c.ISSUER ?? ''),
            display_decimals: c.DISPLAY_DECIMALS
              ? Number(c.DISPLAY_DECIMALS)
              : undefined,
            name: c.NAME ? String(c.NAME) : undefined,
            desc: c.DESC ? String(c.DESC) : undefined,
            conditions: c.CONDITIONS
              ? String(c.CONDITIONS)
              : undefined,
            image: c.IMAGE ? String(c.IMAGE) : undefined,
            anchor_asset_type: c.ANCHOR_ASSET_TYPE
              ? String(c.ANCHOR_ASSET_TYPE)
              : undefined,
            anchor_asset: c.ANCHOR_ASSET
              ? String(c.ANCHOR_ASSET)
              : undefined,
            redemption_instructions: c.REDEMPTION_INSTRUCTIONS
              ? String(c.REDEMPTION_INSTRUCTIONS)
              : undefined,
            collateral_addresses: c.COLLATERAL_ADDRESSES
              ? String(c.COLLATERAL_ADDRESSES)
              : undefined,
            regulated: c.REGULATED ? Boolean(c.REGULATED) : undefined,
            approval_server: c.APPROVAL_SERVER
              ? String(c.APPROVAL_SERVER)
              : undefined,
            approval_criteria: c.APPROVAL_CRITERIA
              ? String(c.APPROVAL_CRITERIA)
              : undefined,
          }))
        : [],
      validators: Array.isArray(parsed.VALIDATORS)
        ? (parsed.VALIDATORS as Record<string, unknown>[]).map((v) => ({
            PUBLIC_KEY: String(v.PUBLIC_KEY ?? ''),
            NAME: v.NAME ? String(v.NAME) : undefined,
            HOST: v.HOST ? String(v.HOST) : undefined,
            HISTORY_URL: v.HISTORY_URL
              ? String(v.HISTORY_URL)
              : undefined,
          }))
        : [],
      documentation: parsed.DOCUMENTATION
        ? {
            PRINCIPALS_NAME: (parsed.DOCUMENTATION as Record<string, unknown>)
              .PRINCIPALS_NAME
              ? String(
                  (parsed.DOCUMENTATION as Record<string, unknown>)
                    .PRINCIPALS_NAME,
                )
              : undefined,
            PRINCIPAL_EMAIL: (parsed.DOCUMENTATION as Record<string, unknown>)
              .PRINCIPAL_EMAIL
              ? String(
                  (parsed.DOCUMENTATION as Record<string, unknown>)
                    .PRINCIPAL_EMAIL,
                )
              : undefined,
            PROJECT_URL: (parsed.DOCUMENTATION as Record<string, unknown>)
              .PROJECT_URL
              ? String(
                  (parsed.DOCUMENTATION as Record<string, unknown>)
                    .PROJECT_URL,
                )
              : undefined,
            OFFICIAL_CHAT: (parsed.DOCUMENTATION as Record<string, unknown>)
              .OFFICIAL_CHAT
              ? String(
                  (parsed.DOCUMENTATION as Record<string, unknown>)
                    .OFFICIAL_CHAT,
                )
              : undefined,
            OTHER_INFO: (parsed.DOCUMENTATION as Record<string, unknown>)
              .OTHER_INFO
              ? String(
                  (parsed.DOCUMENTATION as Record<string, unknown>)
                    .OTHER_INFO,
                )
              : undefined,
          }
        : null,
      fetchLatencyMs: latencyMs,
      validationWarnings,
    };
  }

  // ─── GET /federation/sep ────────────────────────────────────────────────

  async getSepSupport(domain: string): Promise<SepResult> {
    const cleanDomain = stripProtocol(domain.trim());
    if (!isDomain(cleanDomain)) {
      throw new BadRequestException(`Invalid domain: ${domain}`);
    }

    let tomlData: Record<string, unknown>;
    try {
      tomlData = await this.fetchToml(cleanDomain);
    } catch {
      return {
        seps: [
          {
            number: 1,
            name: 'stellar.toml',
            supported: false,
            endpoint: null,
            probeStatus: 'red',
          },
          {
            number: 6,
            name: 'Anchor API',
            supported: false,
            endpoint: null,
            probeStatus: 'red',
          },
          {
            number: 10,
            name: 'Stellar Web Authentication',
            supported: false,
            endpoint: null,
            probeStatus: 'red',
          },
          {
            number: 24,
            name: 'Interactive Anchor API',
            supported: false,
            endpoint: null,
            probeStatus: 'red',
          },
          {
            number: 31,
            name: 'Direct Payments',
            supported: false,
            endpoint: null,
            probeStatus: 'red',
          },
        ],
      };
    }

    const seps: SepInfo[] = [];

    // SEP-1: stellar.toml is present
    seps.push({
      number: 1,
      name: 'stellar.toml',
      supported: true,
      endpoint: `https://${cleanDomain}/.well-known/stellar.toml`,
      probeStatus: 'green',
    });

    // SEP-6: TRANSFER_SERVER present
    const transferServer = tomlData.TRANSFER_SERVER as string | undefined;
    if (transferServer) {
      const probeStatus = await this.probeEndpoint(transferServer, '/info');
      seps.push({
        number: 6,
        name: 'Anchor API',
        supported: true,
        endpoint: transferServer,
        probeStatus,
      });
    } else {
      seps.push({
        number: 6,
        name: 'Anchor API',
        supported: false,
        endpoint: null,
        probeStatus: 'red',
      });
    }

    // SEP-10: WEB_AUTH_ENDPOINT present
    const webAuthEndpoint = tomlData.WEB_AUTH_ENDPOINT as string | undefined;
    if (webAuthEndpoint) {
      const probeStatus = await this.probeEndpoint(
        webAuthEndpoint,
        '/web_auth',
      );
      seps.push({
        number: 10,
        name: 'Stellar Web Authentication',
        supported: true,
        endpoint: webAuthEndpoint,
        probeStatus,
      });
    } else {
      seps.push({
        number: 10,
        name: 'Stellar Web Authentication',
        supported: false,
        endpoint: null,
        probeStatus: 'red',
      });
    }

    // SEP-24: TRANSFER_SERVER_SEP0024 present
    const transferServerSep0024 = tomlData.TRANSFER_SERVER_SEP0024 as
      | string
      | undefined;
    if (transferServerSep0024) {
      seps.push({
        number: 24,
        name: 'Interactive Anchor API',
        supported: true,
        endpoint: transferServerSep0024,
        probeStatus: 'green',
      });
    } else {
      seps.push({
        number: 24,
        name: 'Interactive Anchor API',
        supported: false,
        endpoint: null,
        probeStatus: 'red',
      });
    }

    // SEP-31: DIRECT_PAYMENT_SERVER present
    const directPaymentServer = tomlData.DIRECT_PAYMENT_SERVER as
      | string
      | undefined;
    if (directPaymentServer) {
      seps.push({
        number: 31,
        name: 'Direct Payments',
        supported: true,
        endpoint: directPaymentServer,
        probeStatus: 'green',
      });
    } else {
      seps.push({
        number: 31,
        name: 'Direct Payments',
        supported: false,
        endpoint: null,
        probeStatus: 'red',
      });
    }

    return { seps };
  }

  // ─── GET /federation/link-preview (Savitura/Savitools#217) ───────────────

  /**
   * Build a standards-aware anchor transfer request link from stellar.toml.
   * The returned URL is copy-only: SaviTools never signs or submits it.
   */
  async buildTransferRequestLink(
    domain: string,
    params: TransferLinkParams,
  ): Promise<TransferLinkResult> {
    const cleanDomain = stripProtocol(domain.trim());
    if (!isDomain(cleanDomain)) {
      throw new BadRequestException(`Invalid domain: ${domain}`);
    }

    // Amounts and memos stay strings end-to-end — no floating-point conversion.
    if (!DECIMAL_STRING_RE.test(params.amount)) {
      throw new BadRequestException(
        'amount must be a non-negative decimal string (e.g. "100.50")',
      );
    }

    if (params.callback && !HTTPS_URL_RE.test(params.callback)) {
      throw new BadRequestException(
        'callback must be a well-formed https:// URL',
      );
    }

    if (params.sep !== '31' && !params.account) {
      throw new BadRequestException(
        `account (Stellar public key G…) is required for SEP-${params.sep} request links`,
      );
    }
    if (params.account && !PUBLIC_KEY_RE.test(params.account)) {
      throw new BadRequestException('account must be a Stellar public key (G…)');
    }

    const tomlData = await this.fetchToml(cleanDomain);

    const endpointBySep: Record<TransferRequestSep, string | undefined> = {
      '6': (tomlData.TRANSFER_SERVER as string | undefined) ?? undefined,
      '24': (tomlData.TRANSFER_SERVER_SEP0024 as string | undefined) ?? undefined,
      '31': (tomlData.DIRECT_PAYMENT_SERVER as string | undefined) ?? undefined,
    };
    const endpoint = endpointBySep[params.sep];
    if (!endpoint) {
      throw new BadRequestException(
        `Domain ${cleanDomain} does not declare a ` +
          `${params.sep === '6' ? 'TRANSFER_SERVER' : params.sep === '24' ? 'TRANSFER_SERVER_SEP0024' : 'DIRECT_PAYMENT_SERVER'} ` +
          `endpoint in its stellar.toml, so SEP-${params.sep} request links are unavailable`,
      );
    }

    const currencies = Array.isArray(tomlData.CURRENCIES)
      ? (tomlData.CURRENCIES as Record<string, unknown>[])
      : [];
    const supportedCodes = new Set(
      currencies.map((c) => String(c.CODE ?? '').toUpperCase()),
    );
    if (!supportedCodes.has(params.asset.toUpperCase())) {
      throw new BadRequestException(
        `Asset '${params.asset}' is not supported by ${cleanDomain}. Supported assets: ` +
          `${[...supportedCodes].join(', ') || '(none declared)'}`,
      );
    }

    const base = endpoint.replace(/\/$/, '');
    let url: string;
    switch (params.sep) {
      case '6': {
        const flow = params.type === 'withdraw' ? 'withdraw' : 'deposit';
        const query = new URLSearchParams({
          type: flow,
          asset_code: params.asset,
          account: params.account as string,
          amount: params.amount,
        });
        if (params.memo !== undefined) {
          query.set('memo', params.memo);
          query.set('memo_type', 'text');
        }
        if (params.callback) query.set('callback', params.callback);
        url = `${base}/transactions?${query.toString()}`;
        break;
      }
      case '24': {
        const query = new URLSearchParams({
          asset_code: params.asset,
          amount: params.amount,
          account: params.account as string,
        });
        if (params.memo !== undefined) query.set('memo', params.memo);
        if (params.callback) query.set('callback', params.callback);
        url = `${base}/?${query.toString()}`;
        break;
      }
      case '31': {
        const query = new URLSearchParams({
          asset_code: params.asset,
          amount: params.amount,
        });
        if (params.account) query.set('account', params.account);
        if (params.callback) query.set('destination', params.callback);
        if (params.memo !== undefined) query.set('memo', params.memo);
        url = `${base}/?${query.toString()}`;
        break;
      }
    }

    return {
      sep: params.sep,
      endpoint: base,
      url,
      asset: params.asset,
      amount: params.amount,
      warning:
        'Preview only: SaviTools will not sign or submit this request. Open the link yourself after reviewing the anchor.',
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private async fetchToml(
    domain: string,
  ): Promise<Record<string, unknown>> {
    const url = `https://${domain}/.well-known/stellar.toml`;
    const res = await this.fetchWithTimeout(url);
    if (!res.ok) {
      throw new NotFoundException(
        `stellar.toml not found at ${url} (HTTP ${res.status})`,
      );
    }
    const raw = await res.text();
    return parseBoundedToml(raw);
  }

  private async probeEndpoint(
    baseUrl: string,
    path: string,
  ): Promise<'green' | 'yellow'> {
    try {
      const url = `${baseUrl.replace(/\/$/, '')}${path}`;
      const res = await this.fetchWithTimeout(url, 8000);
      return res.ok ? 'green' : 'yellow';
    } catch {
      return 'yellow';
    }
  }
}
