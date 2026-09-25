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

/** Same known answer as the Webhook Tester and contract replay specs. */
const KAT_SECRET = "whsec_test-secret-123";
const KAT_TIMESTAMP = 1_700_000_000;
const KAT_BODY = JSON.stringify({
  id: "alert-one",
  watchId: "watch-one",
  ruleId: "rule-one",
  event: {
    paging_token: "123",
    amount: "55.0000000",
    asset_type: "native",
    from: "GSENDER",
    to: "GRECEIVER",
  },
});
const KAT_SIGNATURE =
  "sha256=0857bcbd01c63a2dc3c62c0cf30ad58c14eca7024a02241c2d9bbc8e8e1b7774";

function webhookRepositoryFor(secret: string): Repository<MonitorWebhook> {
  return {
    createQueryBuilder: jest.fn().mockReturnValue({
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue({
        url: "https://example.com/stellar",
        secret,
        enabled: true,
      }),
    }),
    update: jest.fn().mockResolvedValue(undefined),
  } as unknown as Repository<MonitorWebhook>;
}

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

  it("matches the known answer for a pinned clock", async () => {
    // Same contract as the Webhook Tester and contract replay: one body, one
    // signature, regardless of which outbound path produced it.
    jest.useFakeTimers().setSystemTime(KAT_TIMESTAMP * 1000);
    try {
      const webhookRepository = webhookRepositoryFor(KAT_SECRET);
      const worker = createWorker(webhookRepository);
      const fetchMock = jest
        .spyOn(global, "fetch")
        .mockResolvedValue({ ok: true, status: 200 } as Response);

      await (
        worker as unknown as {
          sendWebhook: (event: AlertEvent, userId: string) => Promise<void>;
        }
      ).sendWebhook(alertEvent(), "user-one");

      const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      const headers = init.headers as Record<string, string>;

      expect(init.body).toBe(KAT_BODY);
      expect(headers[TIMESTAMP_HEADER]).toBe(String(KAT_TIMESTAMP));
      expect(headers[SIGNATURE_HEADER]).toBe(KAT_SIGNATURE);
    } finally {
      jest.useRealTimers();
    }
  });

  it("emits the SaviTools header pair and never the legacy one", async () => {
    const worker = createWorker(webhookRepositoryFor("test-secret-at-least-sixteen"));
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue({ ok: true, status: 200 } as Response);

    await (
      worker as unknown as {
        sendWebhook: (event: AlertEvent, userId: string) => Promise<void>;
      }
    ).sendWebhook(alertEvent(), "user-one");

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers).toHaveProperty(SIGNATURE_HEADER);
    expect(headers).toHaveProperty(TIMESTAMP_HEADER);
    expect(headers).not.toHaveProperty("X-Webhook-Signature");
    expect(headers).not.toHaveProperty("X-Timestamp");
  });

  it("keeps the same signature across every redirect hop", async () => {
    const worker = createWorker(webhookRepositoryFor("test-secret-at-least-sixteen"));
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
    const fetchMock = global.fetch as unknown as jest.Mock;

    await (
      worker as unknown as {
        sendWebhook: (event: AlertEvent, userId: string) => Promise<void>;
      }
    ).sendWebhook(alertEvent(), "user-one");

    const signatures = fetchMock.mock.calls.map(
      (call) => (call[1].headers as Record<string, string>)[SIGNATURE_HEADER],
    );
    expect(new Set(signatures).size).toBe(1);
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
