import { BadRequestException } from "@nestjs/common";
import { Between, LessThan } from "typeorm";
import { NetworkSample } from "./entities/network-sample.entity";
import { NetworkService } from "./network.service";

describe("NetworkService", () => {
  let service: NetworkService;
  let repository: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    delete: jest.Mock;
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
    repository = {
      create: jest.fn((sample) => sample),
      save: jest.fn(async (sample) => sample),
      find: jest.fn(),
      delete: jest.fn(),
    };

    service = new NetworkService(
      {
        get: jest.fn((key: string, fallback?: string) => fallback),
      } as any,
      repository as any,
      {
        create: jest.fn(),
        save: jest.fn(),
        find: jest.fn(),
        findOne: jest.fn(),
        update: jest.fn(),
        remove: jest.fn(),
      } as any,
    );
  });

  afterEach(() => {
    if ((service as any).pollInterval) {
      clearInterval((service as any).pollInterval);
    }
  });

  describe("pollAndStore", () => {
    it("stores a successful sample for each network", async () => {
      jest
        .spyOn(service, "fetchCurrentStatus")
        .mockImplementation(async (network) => ({
          timestamp: Date.now(),
          network: typeof network === "string" ? network : network.name,
          passphrase: "passphrase",
          ledger: {
            sequence: 1,
            closeTime: new Date().toISOString(),
            secondsSinceClose: 1,
            avgCloseTime: 5,
          },
          fees: {
            baseFee: { min: 100, mode: 100, max: 100 },
            percentiles: { p10: 100, p50: 100, p90: 100, p99: 100 },
          },
          latency: 25,
        }));

      await service.pollAndStore();

      expect(repository.save).toHaveBeenCalledTimes(2);
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ network: "mainnet", ok: true, error: null }),
      );
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ network: "testnet", ok: true, error: null }),
      );
    });

    it("stores a failed sample without blocking the other network", async () => {
      jest
        .spyOn(service, "fetchCurrentStatus")
        .mockImplementation(async (network) => {
          if (typeof network === "string" && network === "mainnet") {
            throw new Error("mainnet down");
          }
          return {
            timestamp: Date.now(),
            network: typeof network === "string" ? network : network.name,
            passphrase: "passphrase",
            ledger: {
              sequence: 1,
              closeTime: new Date().toISOString(),
              secondsSinceClose: 1,
              avgCloseTime: 5,
            },
            fees: {
              baseFee: { min: 100, mode: 100, max: 100 },
              percentiles: { p10: 100, p50: 100, p90: 100, p99: 100 },
            },
            latency: 25,
          };
        });

      await service.pollAndStore();

      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          network: "mainnet",
          ok: false,
          error: "mainnet down",
        }),
      );
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ network: "testnet", ok: true }),
      );
    });

    it("does not queue overlapping sampler runs", async () => {
      (service as any).pollInProgress = true;

      await service.pollAndStore();

      expect(repository.save).not.toHaveBeenCalled();
      expect(repository.delete).not.toHaveBeenCalled();
    });
  });

  describe("getHistory", () => {
    it("returns 1-minute buckets with uptime and latency summary", async () => {
      const samples: Partial<NetworkSample>[] = [
        sample("testnet", "2026-08-31T10:00:10.000Z", true, 100),
        sample("testnet", "2026-08-31T10:00:40.000Z", true, 200),
        sample("testnet", "2026-08-31T10:01:05.000Z", false, null),
        sample("testnet", "2026-08-31T10:02:05.000Z", true, 300),
      ];
      repository.find.mockResolvedValue(samples);

      const result = await service.getHistory(
        "testnet",
        "2026-08-31T10:00:00.000Z",
        "2026-08-31T10:03:00.000Z",
      );

      expect(repository.find).toHaveBeenCalledWith({
        where: {
          network: "testnet",
          sampledAt: Between(
            new Date("2026-08-31T10:00:00.000Z"),
            new Date("2026-08-31T10:03:00.000Z"),
          ),
        },
        order: { sampledAt: "ASC" },
      });
      expect(result.samples).toEqual([
        expect.objectContaining({
          sampledAt: "2026-08-31T10:00:00.000Z",
          ok: true,
          latencyMs: 150,
          sampleCount: 2,
          errorCount: 0,
        }),
        expect.objectContaining({
          sampledAt: "2026-08-31T10:01:00.000Z",
          ok: false,
          latencyMs: null,
          sampleCount: 1,
          errorCount: 1,
        }),
        expect.objectContaining({
          sampledAt: "2026-08-31T10:02:00.000Z",
          ok: true,
          latencyMs: 300,
          sampleCount: 1,
          errorCount: 0,
        }),
      ]);
      expect(result.summary).toEqual({
        uptimePercent: 66.67,
        p50LatencyMs: 150,
        p95LatencyMs: 300,
        outageCount: 1,
        sampleCount: 4,
      });
    });

    it("validates malformed and inverted date ranges", async () => {
      await expect(
        service.getHistory("mainnet", "not-a-date", undefined),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.getHistory(
          "mainnet",
          "2026-08-31T10:05:00.000Z",
          "2026-08-31T10:00:00.000Z",
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("pruneRetention", () => {
    it("deletes samples older than 90 days", async () => {
      await service.pruneRetention(new Date("2026-08-31T12:00:00.000Z"));

      expect(repository.delete).toHaveBeenCalledWith({
        sampledAt: LessThan(new Date("2026-06-02T12:00:00.000Z")),
      });
    });
  });
});

function sample(
  network: "mainnet" | "testnet",
  sampledAt: string,
  ok: boolean,
  latencyMs: number | null,
): Partial<NetworkSample> {
  return {
    network,
    sampledAt: new Date(sampledAt),
    ok,
    latencyMs,
    horizonBaseUrl:
      network === "mainnet"
        ? "https://horizon.stellar.org"
        : "https://horizon-testnet.stellar.org",
    error: ok ? null : "timeout",
  };
}
