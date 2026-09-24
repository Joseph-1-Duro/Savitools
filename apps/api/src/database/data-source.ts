import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { User } from '../modules/auth/entities/user.entity';
import { RefreshToken } from '../modules/auth/entities/refresh-token.entity';
import { ConnectedAccount } from '../modules/auth/entities/connected-account.entity';
import { PasskeyCredential } from '../modules/auth/entities/passkey.entity';
import { VaultKey } from '../modules/auth/entities/vault-key.entity';
import { Workspace } from '../modules/workspace/entities/workspace.entity';
import { ApiKey } from '../modules/playground/entities/api-key.entity';
import { PlaygroundHistory } from '../modules/playground/entities/playground-history.entity';
import { AlertEvent } from '../modules/monitor/entities/alert-event.entity';
import { MonitorWebhook } from '../modules/monitor/entities/monitor-webhook.entity';
import { WatchEvent } from '../modules/monitor/entities/watch-event.entity';
import { Watch } from '../modules/monitor/entities/watch.entity';
import { TransactionReplay } from '../modules/transaction/entities/transaction-replay.entity';
import { NetworkSample } from '../modules/network/entities/network-sample.entity';
import { CreateLedgerMonitor1752926400000 } from './migrations/1752926400000-create-ledger-monitor';
import { CreatePlaygroundHistory1784642239000 } from './migrations/1784642239000-create-playground-history';
import { AddMonitorStateAlerts1785312000000 } from './migrations/1785312000000-add-monitor-state-alerts';
import { AddAuthEnhancements1785398400000 } from './migrations/1785398400000-add-auth-enhancements';
import { CreateTransactionReplay1785700000000 } from './migrations/1785700000000-create-transaction-replay';
import { CreateNetworkSamples1785786400000 } from './migrations/1785786400000-create-network-samples';
import { CreatePasskeys1786200000000 } from './migrations/1786200000000-create-passkeys';

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [
    User,
    RefreshToken,
    ConnectedAccount,
    PasskeyCredential,
    VaultKey,
    Workspace,
    ApiKey,
    PlaygroundHistory,
    Watch,
    WatchEvent,
    AlertEvent,
    MonitorWebhook,
    TransactionReplay,
    NetworkSample,
  ],
  migrations: [
    CreateLedgerMonitor1752926400000,
    CreatePlaygroundHistory1784642239000,
    AddMonitorStateAlerts1785312000000,
    AddAuthEnhancements1785398400000,
    CreateTransactionReplay1785700000000,
    CreateNetworkSamples1785786400000,
    CreatePasskeys1786200000000,
  ],
  synchronize: false,
});
