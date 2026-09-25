import { Module, Logger, OnApplicationBootstrap } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { AuthModule } from "./modules/auth/auth.module";
import { PlaygroundModule } from "./modules/playground/playground.module";
import { WorkspaceModule } from "./modules/workspace/workspace.module";
import { MonitorModule } from "./modules/monitor/monitor.module";
import { SdkgenModule } from "./modules/sdkgen/sdkgen.module";
import { ContractsModule } from "./modules/contracts/contracts.module";
import { NetworkModule } from "./modules/network/network.module";
import { StellarTestnetModule } from "./modules/stellar/stellar-testnet.module";
import { WalletModule } from "./modules/wallet/wallet.module";
import { SimulatorModule } from "./modules/simulator/simulator.module";
import { WebhookModule } from "./modules/webhook/webhook.module";
import { ComposerModule } from "./modules/composer/composer.module";
import { InspectorModule } from "./modules/inspector/inspector.module";
import { TransactionModule } from "./modules/transaction/transaction.module";
import { FederationModule } from "./modules/federation/federation.module";
import { MetricsModule } from "./modules/metrics/metrics.module";
import { DataSource } from "typeorm";
import { CreatePlaygroundHistory1784642239000 } from "./database/migrations/1784642239000-create-playground-history";
import { CreateLedgerMonitor1752926400000 } from "./database/migrations/1752926400000-create-ledger-monitor";
import { AddMonitorStateAlerts1785312000000 } from "./database/migrations/1785312000000-add-monitor-state-alerts";
import { AddAuthEnhancements1785398400000 } from "./database/migrations/1785398400000-add-auth-enhancements";
import { CreateGraphSnapshots1785600000000 } from "./database/migrations/1785600000000-create-graph-snapshots";
import { CreateNetworkSamples1785786400000 } from "./database/migrations/1785786400000-create-network-samples";
import { AddPasswordReset1786100000000 } from "./database/migrations/1786100000000-add-password-reset";
import { AddSecretEncryptionVersioning1786300000000 } from "./database/migrations/1786300000000-add-secret-encryption-versioning";
import { validateEnvironment } from "./config/env-validation";
import { CommonModule } from "./common/common.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnvironment }),
ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService) => [
    {
      ttl: config.get<number>("THROTTLE_TTL", 60000),
      limit: config.get<number>("THROTTLE_LIMIT", 100),
      skipIf: (context) => {
        const request = context.switchToHttp().getRequest();
        return request.method === "OPTIONS";
      },
    },
  ],
}),
    

    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: "postgres",
        url: config.get<string>("DATABASE_URL"),
        autoLoadEntities: true,
        synchronize: config.get<string>("NODE_ENV") !== "production",
        migrations: [
          CreateLedgerMonitor1752926400000,
          CreatePlaygroundHistory1784642239000,
          AddMonitorStateAlerts1785312000000,
          AddAuthEnhancements1785398400000,
          CreateGraphSnapshots1785600000000,
          CreateNetworkSamples1785786400000,
          AddPasswordReset1786100000000,
          AddSecretEncryptionVersioning1786300000000,
        ],
        migrationsRun: config.get<string>("RUN_MIGRATIONS") === "true",
        logging: config.get<string>("NODE_ENV") === "development",
      }),
    }),

    CommonModule,
    AuthModule,
    StellarTestnetModule,
    PlaygroundModule,
    WorkspaceModule,
    MonitorModule,
    SdkgenModule,
    ContractsModule,
    NetworkModule,
    SimulatorModule,
    WebhookModule,
    ComposerModule,
    InspectorModule,
    TransactionModule,
    FederationModule,
    MetricsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule implements OnApplicationBootstrap {
  private readonly logger = new Logger(AppModule.name);

  constructor(
    private dataSource: DataSource,
    private configService: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    const isProduction =
      this.configService.get<string>("NODE_ENV") === "production";
    const autoRun = this.configService.get<string>("RUN_MIGRATIONS") === "true";

    // Fail fast in production if migrations are behind and auto-run is not enabled
    if (isProduction && !autoRun) {
      const hasPending = await this.dataSource.showMigrations();
      if (hasPending) {
        this.logger.error(
          "Pending migrations detected in production. Failing fast.",
        );
        process.exit(1);
      }
    }
  }
}
