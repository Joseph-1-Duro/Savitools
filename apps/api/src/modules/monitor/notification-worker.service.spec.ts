import { ConfigService } from "@nestjs/config";
import { Repository } from "typeorm";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signBody,
} from "../webhook/signature";
import { User } from "../auth/entities/user.entity";
import { AlertEvent } from "./entities/alert-event.entity";
import { MonitorWebhook } from "./entities/monitor-webhook.entity";
import { Watch } from "./entities/watch.entity";
import { MonitorGateway } from "./monitor.gateway";
import { NotificationWorkerService } from "./notification-worker.service";

describe("NotificationWorkerService", () => {
  beforeEach(() => {
    jest
      .spyOn(require("dns/promises"), "lookup")
      .mockResolvedValue([{ address: "93.184.216.34" }]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("sends the full event payload with a valid webhook HMAC", async () => {
    const secret = "test-secret-at-least-sixteen";
    const webhook = {
      url: "https://example.com/stellar",
      secret,
      enabled: true,
    } as MonitorWebhook;
    const queryBuilder = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(webhook),
    };
    const webhookRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      update: jest.fn().mockResolvedValue(undefined),
    } as unknown as Repository<MonitorWebhook>;
    const worker = createWorker(webhookRepository);
    const response = { ok: true, status: 200 } as Response;
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(response);
    const alert = alertEvent();

    await (
      worker as unknown as {
        sendWebhook: (event: AlertEvent, userId: string) => Promise<void>;
      }
    ).sendWebhook(alert, "user-one");

    const body = JSON.stringify({
      id: alert.id,
      watchId: alert.watchId,
      ruleId: alert.ruleId,
      event: alert.payload,
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    // What a receiving endpoint would compute over raw body + timestamp.
    const expected = signBody({
      secret,
      body,
      timestamp: Number(headers[TIMESTAMP_HEADER]),
    }).signature;

    expect(url).toEqual(new URL(webhook.url));
    expect(init.method).toBe("POST");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers[TIMESTAMP_HEADER]).toMatch(/^\d+$/);
    expect(headers[SIGNATURE_HEADER]).toBe(expected);
  });

  it("rejects a webhook that resolves to a private address", async () => {
    const webhookRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          url: "https://internal.example/hook",
          secret: "test-secret-at-least-sixteen",
        }),
      }),
      update: jest.fn().mockResolvedValue(undefined),
    } as unknown as Repository<MonitorWebhook>;
    const worker = createWorker(webhookRepository);
    const fetchMock = jest.spyOn(global, "fetch");
    jest
      .spyOn(require("dns/promises"), "lookup")
      .mockResolvedValue([{ address: "127.0.0.1" }]);

    await expect(
      (worker as any).sendWebhook(alertEvent(), "user-one"),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("revalidates redirect destinations before delivery", async () => {
    const webhookRepository = {
      createQueryBuilder: jest.fn().mockReturnValue({
        addSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          url: "https://example.com/hook",
          secret: "test-secret-at-least-sixteen",
        }),
      }),
      update: jest.fn().mockResolvedValue(undefined),
    } as unknown as Repository<MonitorWebhook>;
    const worker = createWorker(webhookRepository);
    jest
      .spyOn(require("dns/promises"), "lookup")
      .mockResolvedValue([{ address: "93.184.216.34" }]);
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce({
        status: 302,
        ok: false,
        headers: new Headers({ location: "https://example.com/next" }),
      } as Response)
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        headers: new Headers(),
      } as Response);

    await expect(
      (worker as any).sendWebhook(alertEvent(), "user-one"),
    ).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("includes the full event payload in email notifications", async () => {
    const worker = createWorker({} as Repository<MonitorWebhook>);
    const send = jest
      .fn()
      .mockResolvedValue({ data: { id: "email-one" }, error: null });
    (
      worker as unknown as {
        resend: { emails: { send: typeof send } };
      }
    ).resend = { emails: { send } };
    const alert = alertEvent();
    const user = { email: "owner@example.com" } as User;

    await (
      worker as unknown as {
        sendEmail: (event: AlertEvent, owner: User) => Promise<void>;
      }
    ).sendEmail(alert, user);

    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: user.email,
        text: JSON.stringify(alert.payload, null, 2),
      }),
    );
  });
});

function createWorker(
  webhookRepository: Repository<MonitorWebhook>,
): NotificationWorkerService {
  const config = {
    get: jest.fn((key: string, fallback?: string) =>
      key === "RESEND_FROM_EMAIL" ? "alerts@example.com" : fallback,
    ),
  } as unknown as ConfigService;
  const encryptionService = {
    encryptForUser: jest.fn().mockReturnValue({
      encrypted: "encrypted",
      iv: "iv",
      authTag: "authTag",
    }),
    decryptForUser: jest.fn(),
  };
  return new NotificationWorkerService(
    config,
    {} as Repository<AlertEvent>,
    webhookRepository,
    {} as Repository<User>,
    { emitToUser: jest.fn() } as unknown as MonitorGateway,
    encryptionService as any,
  );
}

function alertEvent(): AlertEvent {
  return {
    id: "alert-one",
    watchId: "watch-one",
    ruleId: "rule-one",
    payload: {
      paging_token: "123",
      amount: "55.0000000",
      asset_type: "native",
      from: "GSENDER",
      to: "GRECEIVER",
    },
    watch: {
      publicKey: "GACCOUNT",
      label: "Treasury",
    } as Watch,
  } as unknown as AlertEvent;
}
