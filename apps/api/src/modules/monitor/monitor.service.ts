import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { StrKey } from '@stellar/stellar-sdk';
import { randomUUID } from 'crypto';
import { Repository } from 'typeorm';
import { AlertEvent } from './entities/alert-event.entity';
import { MonitorWebhook } from './entities/monitor-webhook.entity';
import { WatchEvent } from './entities/watch-event.entity';
import { Watch } from './entities/watch.entity';
import { AlertRuleDto, CreateWatchDto } from './dto/create-watch.dto';
import { PaginationQueryDto } from './dto/pagination-query.dto';
import { RegisterWebhookDto } from './dto/register-webhook.dto';
import {
  EXPORT_CHUNK_SIZE,
  EXPORT_MAX_ROWS,
  SearchEventsQueryDto,
} from './dto/search-events.dto';
import { MonitorQueueService } from './monitor-queue.service';
import {
  AlertRuleDefinition,
  NotificationChannel,
  WatchEventType,
  WatchType,
} from './monitor.types';
import { StreamManager } from './stream-manager.service';
import { WatchRegistry } from './watch-registry.service';
import { EncryptionService, ENCRYPTION_PURPOSES } from '../../common/encryption.service';

@Injectable()
export class MonitorService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(Watch)
    private readonly watchRepository: Repository<Watch>,
    @InjectRepository(WatchEvent)
    private readonly watchEventRepository: Repository<WatchEvent>,
    @InjectRepository(AlertEvent)
    private readonly alertEventRepository: Repository<AlertEvent>,
    @InjectRepository(MonitorWebhook)
    private readonly webhookRepository: Repository<MonitorWebhook>,
    private readonly registry: WatchRegistry,
    private readonly streamManager: StreamManager,
    private readonly queue: MonitorQueueService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.registry.load();
    await this.streamManager.startAll();
  }

  async createWatch(userId: string, dto: CreateWatchDto): Promise<Watch> {
    const publicKey = dto.publicKey.trim();
    const type = this.watchType(publicKey);
    this.validateEventTypes(type, dto.eventTypes);
    const alertRules = (dto.alertRules ?? []).map((rule) =>
      this.toAlertRule(rule, type),
    );

    const key = `${dto.network ?? 'testnet'}:${type}:${publicKey}`;
    const existing = this.registry.get(key)[0];
    const watch = await this.watchRepository.save(
      this.watchRepository.create({
        userId,
        publicKey,
        type,
        label: dto.label?.trim() || null,
        network: dto.network ?? 'testnet',
        eventTypes: Array.from(new Set(dto.eventTypes)),
        alertRules,
        alertState: {},
        lastEvaluatedAt: null,
        transactionCursor: existing?.transactionCursor ?? null,
        paymentCursor: existing?.paymentCursor ?? null,
        contractCursor: existing?.contractCursor ?? null,
        cursorLedger: existing?.cursorLedger ?? null,
        streamMode: existing?.streamMode ?? 'poll',
        status: existing?.status ?? 'polling',
        lastEventAt: existing?.lastEventAt ?? null,
        lastError: existing?.lastError ?? null,
      }),
    );

    this.registry.add(watch);
    await this.streamManager.start(this.registry.keyFor(watch));
    return watch;
  }

  async getWatches(userId: string): Promise<Watch[]> {
    return this.watchRepository.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
  }

  async listWatches(
    userId: string,
    query?: PaginationQueryDto,
  ): Promise<{ items: Watch[]; page: number; limit: number; total: number }> {
    const page = query?.page ?? 1;
    const limit = query?.limit ?? 50;
    const [items, total] = await this.watchRepository.findAndCount({
      where: { userId },
      order: { createdAt: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return { items, page, limit, total };
  }

  async getWatch(userId: string, watchId: string): Promise<Watch> {
    return this.requireWatch(userId, watchId);
  }

  async getWatchEvents(
    userId: string,
    watchId: string,
    query: PaginationQueryDto,
  ): ReturnType<MonitorService['getEvents']> {
    return this.getEvents(userId, watchId, query);
  }

  async getAlertEvents(
    userId: string,
    watchId: string,
    query: PaginationQueryDto,
  ): ReturnType<MonitorService['getAlerts']> {
    return this.getAlerts(userId, watchId, query);
  }

  async getWebhook(
    userId: string,
  ): Promise<Pick<MonitorWebhook, 'id' | 'url' | 'enabled' | 'createdAt'> | null> {
    const webhook = await this.webhookRepository.findOne({ where: { userId } });
    if (!webhook) return null;
    return {
      id: webhook.id,
      url: webhook.url,
      enabled: webhook.enabled,
      createdAt: webhook.createdAt,
    };
  }

  async deleteWatch(userId: string, watchId: string): Promise<void> {
    const watch = await this.requireWatch(userId, watchId);
    await this.watchRepository.delete(watch.id);
    if (this.registry.remove(watch)) {
      await this.streamManager.stop(this.registry.keyFor(watch));
    }
  }

  async getEvents(
    userId: string,
    watchId: string,
    query: PaginationQueryDto,
  ): Promise<{
    items: WatchEvent[];
    page: number;
    limit: number;
    total: number;
  }> {
    await this.requireWatch(userId, watchId);
    const [items, total] = await this.watchEventRepository.findAndCount({
      where: { watchId },
      order: { createdAt: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { items, page: query.page, limit: query.limit, total };
  }

  async getAlerts(
    userId: string,
    watchId: string,
    query: PaginationQueryDto,
  ): Promise<{
    items: AlertEvent[];
    page: number;
    limit: number;
    total: number;
  }> {
    await this.requireWatch(userId, watchId);
    const [items, total] = await this.alertEventRepository.findAndCount({
      where: { watchId },
      order: { createdAt: 'DESC' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    });
    return { items, page: query.page, limit: query.limit, total };
  }

  async addAlertRule(
    userId: string,
    watchId: string,
    dto: AlertRuleDto,
  ): Promise<AlertRuleDefinition> {
    const watch = await this.requireWatch(userId, watchId);
    const rule = this.toAlertRule(dto, watch.type);
    watch.alertRules = [...watch.alertRules, rule];
    await this.watchRepository.save(watch);
    this.registry.add(watch);
    return rule;
  }

  async resendAlert(
    userId: string,
    watchId: string,
    alertId: string,
  ): Promise<AlertEvent> {
    await this.requireWatch(userId, watchId);
    const alert = await this.alertEventRepository.findOne({
      where: { id: alertId, watchId },
    });
    if (!alert) {
      throw new NotFoundException('Alert event not found');
    }

    alert.deliveryStatus = 'pending';
    alert.deliveryAttempts = alert.deliveryAttempts.map((attempt) => ({
      channel: attempt.channel,
      status: 'pending',
    }));
    alert.deliveredAt = null;
    await this.alertEventRepository.save(alert);
    await this.queue.enqueue(alert.id, true);
    return alert;
  }

  /**
   * Search watch events across the current user's watches with the same
   * filters used by the CSV export endpoint (see Savitura/Savitools#147).
   */
  async searchEvents(
    userId: string,
    query: SearchEventsQueryDto,
  ): Promise<{ items: WatchEvent[]; page: number; limit: number; total: number }> {
    const qb = this.watchEventRepository
      .createQueryBuilder('event')
      .innerJoin('event.watch', 'watch')
      .where('watch.user_id = :userId', { userId })
      .orderBy('event.occurred_at', 'DESC');

    if (query.watchId) {
      qb.andWhere('event.watch_id = :watchId', { watchId: query.watchId });
    }
    if (query.eventType) {
      qb.andWhere('event.event_type = :eventType', { eventType: query.eventType });
    }
    if (query.from) {
      qb.andWhere('event.occurred_at >= :from', { from: new Date(query.from) });
    }
    if (query.to) {
      qb.andWhere('event.occurred_at <= :to', { to: new Date(query.to) });
    }
    if (query.q?.trim()) {
      qb.andWhere(
        `(event.paging_token ILIKE :q OR event.payload::text ILIKE :q OR event.source ILIKE :q)`,
        { q: `%${query.q.trim()}%` },
      );
    }

    const [items, total] = await qb
      .skip((query.page - 1) * query.limit)
      .take(query.limit)
      .getManyAndCount();

    return { items, page: query.page, limit: query.limit, total };
  }

  /**
   * Stream matching events to a CSV callback in bounded chunks so large result
   * sets never load fully into memory (see Savitura/Savitools#147).
   *
   * @param onRow  called once per event with the CSV row values
   * @param onEnd  called after the last row with the total row count written
   */
  async streamSearchEventsCsv(
    userId: string,
    query: SearchEventsQueryDto,
    onRow: (values: (string | number | null)[]) => Promise<void> | void,
    onEnd: (total: number) => Promise<void> | void,
  ): Promise<void> {
    const pageSize = EXPORT_CHUNK_SIZE;
    // Respect the caller's limit, but never exceed the export maximum.
    const maxRows = Math.min(query.limit ?? EXPORT_MAX_ROWS, EXPORT_MAX_ROWS);
    let page = 1;
    let written = 0;

    // Export accepts the same filters as the search endpoint; paginate
    // internally so the caller never has to manage cursors.
    while (written < maxRows) {
      const remaining = maxRows - written;
      const take = Math.min(pageSize, remaining);
      const pageQuery: SearchEventsQueryDto = {
        ...query,
        page,
        limit: take,
      };
      const { items } = await this.searchEvents(userId, pageQuery);
      if (items.length === 0) break;

      for (const event of items) {
        await onRow(this.eventToCsvRow(event));
        written += 1;
      }
      if (items.length < take) break;
      page += 1;
    }

    await onEnd(written);
  }

  /** CSV row values for a watch event, matching the UI feed display. */
  private eventToCsvRow(event: WatchEvent): (string | number | null)[] {
    const payload = event.payload ?? {};
    const amount =
      typeof payload.amount === 'string' || typeof payload.amount === 'number'
        ? String(payload.amount)
        : null;
    const asset =
      payload.asset_type === 'native'
        ? 'XLM'
        : typeof payload.asset_code === 'string'
          ? payload.asset_code
          : typeof payload.asset === 'string'
            ? payload.asset
            : null;
    const from =
      typeof payload.from === 'string'
        ? payload.from
        : typeof payload.source_account === 'string'
          ? payload.source_account
          : null;
    const to =
      typeof payload.to === 'string'
        ? payload.to
        : typeof payload.account === 'string'
          ? payload.account
          : null;
    const txHash =
      typeof payload.transaction_hash === 'string'
        ? payload.transaction_hash
        : typeof payload.hash === 'string'
          ? payload.hash
          : typeof payload.transactionHash === 'string'
            ? payload.transactionHash
            : null;

    return [
      event.eventType,
      event.occurredAt.toISOString(),
      amount,
      asset,
      from,
      to,
      txHash,
      event.pagingToken,
      event.watchId,
      JSON.stringify(payload),
    ];
  }

  async registerWebhook(
    userId: string,
    dto: RegisterWebhookDto,
  ): Promise<Pick<MonitorWebhook, 'id' | 'url' | 'enabled' | 'createdAt'>> {
    const { encrypted, iv, authTag } = this.encryptionService.encryptForUser(
      userId,
      dto.secret,
      ENCRYPTION_PURPOSES.MONITOR_WEBHOOK_SECRET,
    );

    let webhook = await this.webhookRepository.findOne({ where: { userId } });
    if (webhook) {
      webhook.url = dto.url;
      webhook.secret = encrypted;
      webhook.iv = iv;
      webhook.authTag = authTag;
      webhook.secretVersion = 2;
      webhook.enabled = true;
    } else {
      webhook = this.webhookRepository.create({
        userId,
        url: dto.url,
        secret: encrypted,
        iv,
        authTag,
        secretVersion: 2,
        enabled: true,
      });
    }

    const saved = await this.webhookRepository.save(webhook);
    return {
      id: saved.id,
      url: saved.url,
      enabled: saved.enabled,
      createdAt: saved.createdAt,
    };
  }

  private async requireWatch(userId: string, watchId: string): Promise<Watch> {
    const watch = await this.watchRepository.findOne({
      where: { id: watchId, userId },
    });
    if (!watch) {
      throw new NotFoundException('Watch not found');
    }
    return watch;
  }

  private watchType(publicKey: string): WatchType {
    if (StrKey.isValidEd25519PublicKey(publicKey)) {
      return 'account';
    }
    if (StrKey.isValidContract(publicKey)) {
      return 'contract';
    }
    throw new BadRequestException('Invalid Stellar account or contract ID');
  }

  private validateEventTypes(
    type: WatchType,
    eventTypes: WatchEventType[],
  ): void {
    const invalid = eventTypes.some((eventType) =>
      type === 'account' ? eventType === 'contract' : eventType !== 'contract',
    );
    if (invalid) {
      throw new BadRequestException(
        type === 'account'
          ? 'Account watches support transaction and payment events'
          : 'Contract watches support contract events',
      );
    }
  }

  private toAlertRule(
    dto: AlertRuleDto,
    watchType: WatchType,
  ): AlertRuleDefinition {
    if (watchType === 'contract' && dto.type !== 'any_activity') {
      throw new BadRequestException(
        'Contract watches currently support any_activity alerts',
      );
    }
    if (
      (dto.type === 'amount_received_gte' ||
        dto.type === 'amount_sent_gte' ||
        dto.type === 'balance_above' ||
        dto.type === 'balance_below') &&
      !this.validThreshold(dto.threshold)
    ) {
      throw new BadRequestException(
        'Amount rules require a positive threshold',
      );
    }
    if (dto.type === 'asset_received' && !dto.asset?.trim()) {
      throw new BadRequestException('asset_received requires an asset');
    }
    if (
      dto.type === 'transaction_count' &&
      !/^[1-9]\d*$/.test(dto.threshold?.trim() ?? '')
    ) {
      throw new BadRequestException(
        'transaction_count requires a positive whole-number threshold',
      );
    }

    const channels: NotificationChannel[] = dto.channels?.length
      ? Array.from(new Set(dto.channels))
      : ['in_app'];
    return {
      id: randomUUID(),
      type: dto.type,
      ...(dto.asset?.trim() ? { asset: dto.asset.trim() } : {}),
      ...(dto.threshold?.trim() ? { threshold: dto.threshold.trim() } : {}),
      ...(dto.type === 'transaction_count' && dto.windowMinutes
        ? { windowMinutes: dto.windowMinutes }
        : {}),
      channels,
    };
  }

  private validThreshold(value?: string): boolean {
    if (!value || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
      return false;
    }
    return !/^0(?:\.0+)?$/.test(value);
  }
}
