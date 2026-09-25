import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { rpc, StrKey } from "@stellar/stellar-sdk";
import { rpcServer } from "../monitor/horizon";
import { signatureHeaders } from "../webhook/signature";
import {
  MAX_WEBHOOK_REDIRECTS,
  assertSafeWebhookDestination,
} from "../webhook/ssrf-guard";
import {
  DecodedContractEvent,
  EventFilterCriterion,
  applyEventFilters,
} from "./event-filters";
import { decodeScVal } from "./scval-decoder";
import { EventQueryNetwork, QueryEventsDto } from "./dto/query-events.dto";
import { ReplayEventsDto } from "./dto/replay-events.dto";
import { MetricsService } from "../metrics/metrics.service";

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const REPLAY_TIMEOUT_MS = 10_000;
const REPLAY_CONCURRENCY = 4;

export interface QueryEventsResult {
  events: DecodedContractEvent[];
  latestLedger: number;
  cursor: string;
  count: number;
}

export interface ReplayResult {
  index: number;
  eventId: string | null;
  statusCode: number | null;
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export interface ReplaySummary {
  delivered: number;
  failed: number;
  results: ReplayResult[];
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly configService: ConfigService,
    @Optional() private readonly metricsService?: MetricsService,
  ) {}

  /**
   * The monitor module's rpcServer takes 'testnet' | 'public'; this module's
   * API surface uses 'testnet' | 'mainnet' like its contracts/inspector
   * neighbours. Convert at the boundary rather than propagating the split.
   */
  private server(network: EventQueryNetwork = "testnet"): rpc.Server {
    return rpcServer(
      this.configService,
      network === "mainnet" ? "public" : "testnet",
    );
  }

  async queryEvents(dto: QueryEventsDto): Promise<QueryEventsResult> {
    if (!StrKey.isValidContract(dto.contractId)) {
      throw new BadRequestException("Invalid contract ID format");
    }

    if (dto.startLedger !== undefined && dto.cursor) {
      throw new BadRequestException(
        "Provide either startLedger or cursor, not both",
      );
    }

    if (
      dto.startLedger !== undefined &&
      dto.endLedger !== undefined &&
      dto.endLedger <= dto.startLedger
    ) {
      throw new BadRequestException(
        "endLedger must be greater than startLedger",
      );
    }

    const server = this.server(dto.network);
    const request: rpc.Server.GetEventsRequest = {
      filters: [
        { type: dto.type ?? "contract", contractIds: [dto.contractId] },
      ],
      limit: dto.limit ?? 100,
    };

    if (dto.cursor) {
      request.cursor = dto.cursor;
    } else if (dto.startLedger !== undefined) {
      request.startLedger = dto.startLedger;
    } else {
      // Neither anchor given: start from the newest ledger the node holds.
      request.startLedger = await this.latestLedger(server);
    }

    if (dto.endLedger !== undefined) {
      request.endLedger = dto.endLedger;
    }

    const response = await this.fetchEvents(server, request);
    const events = response.events.map((record) => this.decodeEvent(record));

    return {
      events,
      latestLedger: response.latestLedger,
      cursor: response.cursor,
      count: events.length,
    };
  }

  private async latestLedger(server: rpc.Server): Promise<number> {
    try {
      const result = await this.timeRpc("get_latest_ledger", () =>
        server.getLatestLedger(),
      );
      return result.sequence;
    } catch (err) {
      throw this.upstreamError(err, "Failed to reach the Soroban RPC node");
    }
  }

  private async fetchEvents(
    server: rpc.Server,
    request: rpc.Server.GetEventsRequest,
  ): Promise<rpc.Api.GetEventsResponse> {
    try {
      return await this.timeRpc("get_events", () => server.getEvents(request));
    } catch (err) {
      throw this.upstreamError(
        err,
        "Failed to fetch events from the Soroban RPC node",
      );
    }
  }

  private timeRpc<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    return this.metricsService
      ? this.metricsService.timeSorobanRpc(operation, "events", fn)
      : fn();
  }

  /**
   * The SDK rejects with a bare JSON-RPC object ({ code, message }) rather than
   * an Error, so `String(err)` would yield "[object Object]" and lose the one
   * piece of text the caller needs.
   */
  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;

    if (err && typeof err === "object") {
      const { message, code } = err as { message?: unknown; code?: unknown };
      if (typeof message === "string" && message.length > 0) {
        return typeof code === "number"
          ? `${message} (rpc code ${code})`
          : message;
      }
      try {
        return JSON.stringify(err);
      } catch {
        return "Unknown upstream error";
      }
    }

    return String(err);
  }

  /**
   * Soroban RPC keeps only a short event window (roughly 24h on public
   * networks), so an out-of-range startLedger is a user-correctable 400 rather
   * than an opaque upstream failure.
   */
  private upstreamError(err: unknown, fallback: string): Error {
    const message = this.errorMessage(err);

    if (
      /start(Ledger)?|ledger/i.test(message) &&
      /range|retention|not available|too old|must be within/i.test(message)
    ) {
      return new BadRequestException(
        `startLedger is outside the RPC node's retention window (typically ~24h of ledgers): ${message}`,
      );
    }

    this.logger.error(`${fallback}: ${message}`);
    return new BadGatewayException(`${fallback}: ${message}`);
  }

  private decodeEvent(record: rpc.Api.EventResponse): DecodedContractEvent {
    return {
      id: record.id,
      type: record.type,
      ledger: record.ledger,
      ledgerClosedAt: record.ledgerClosedAt,
      pagingToken: record.pagingToken,
      inSuccessfulContractCall: record.inSuccessfulContractCall,
      txHash: record.txHash,
      contractId: record.contractId?.toString() ?? null,
      topic: record.topic.map(decodeScVal),
      value: decodeScVal(record.value),
    };
  }

  filterEvents(
    events: DecodedContractEvent[],
    criteria: EventFilterCriterion[],
  ): { events: DecodedContractEvent[]; count: number } {
    const filtered = applyEventFilters(events, criteria);
    return { events: filtered, count: filtered.length };
  }

  /**
   * Replays events at a user-supplied endpoint, one signed POST per event.
   *
   * Deliberately does not go through WebhookService: that writes every send
   * into a 50-entry Redis history, so a 200-event replay would evict the
   * user's entire webhook history. Follows notification-worker's precedent of
   * importing the SSRF guard directly and running its own send loop.
   */
  async replayEvents(dto: ReplayEventsDto): Promise<ReplaySummary> {
    let destination: URL;
    try {
      destination = new URL(dto.webhookUrl);
    } catch {
      throw new BadRequestException("webhookUrl must be a valid URL");
    }

    await assertSafeWebhookDestination(destination);

    // Per-request secret wins; WEBHOOK_SIGNING_SECRET is the global fallback.
    const secret = dto.secret || this.configService.get<string>('WEBHOOK_SIGNING_SECRET');

    const results: ReplayResult[] = new Array<ReplayResult>(dto.events.length);
    let next = 0;

    // Bounded concurrency: a replay is an outbound amplifier, so it must not
    // open one socket per event.
    const workers = Array.from(
      { length: Math.min(REPLAY_CONCURRENCY, dto.events.length) },
      async () => {
        while (true) {
          const index = next++;
          if (index >= dto.events.length) return;
          results[index] = await this.deliverOne(
            destination,
            dto.events[index],
            index,
            secret,
          );
        }
      },
    );

    await Promise.all(workers);

    const delivered = results.filter((r) => r.ok).length;
    this.logger.log(
      `Replayed ${results.length} event(s) to ${destination.origin}: ${delivered} delivered, ${results.length - delivered} failed`,
    );

    return { delivered, failed: results.length - delivered, results };
  }

  private async deliverOne(
    destination: URL,
    event: unknown,
    index: number,
    secret?: string,
  ): Promise<ReplayResult> {
    const eventId =
      event &&
      typeof event === "object" &&
      typeof (event as { id?: unknown }).id === "string"
        ? (event as { id: string }).id
        : null;

    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (secret) {
      // Same wire format as WebhookService and the notification worker:
      // timestamped hex HMAC-SHA256 over `<timestamp>.<body>`, where `body` is
      // the exact string handed to fetch below.
      Object.assign(headers, signatureHeaders({ secret, body }));
    }

    const startedAt = Date.now();
    try {
      const response = await this.fetchWithRedirectGuard(destination, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(REPLAY_TIMEOUT_MS),
      });

      return {
        index,
        eventId,
        statusCode: response.status,
        ok: response.ok,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      // One bad endpoint must not fail the whole batch.
      return {
        index,
        eventId,
        statusCode: null,
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : "Unknown fetch error",
      };
    }
  }

  /** Re-validates every redirect hop so a 302 cannot walk into a private host. */
  private async fetchWithRedirectGuard(
    url: URL,
    init: RequestInit,
  ): Promise<Response> {
    let currentUrl = url;

    for (let hop = 0; hop <= MAX_WEBHOOK_REDIRECTS; hop++) {
      const response = await fetch(currentUrl, { ...init, redirect: "manual" });

      if (!REDIRECT_STATUS_CODES.has(response.status)) {
        return response;
      }

      const location = response.headers.get("location");
      if (!location) {
        return response;
      }

      currentUrl = new URL(location, currentUrl);
      await assertSafeWebhookDestination(currentUrl);
    }

    throw new BadRequestException("Too many redirects");
  }
}
