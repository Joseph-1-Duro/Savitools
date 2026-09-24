import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ApiKey } from '../../playground/entities/api-key.entity';
import { ConnectedAccount } from './connected-account.entity';
import { RefreshToken } from './refresh-token.entity';
import { VaultKey } from './vault-key.entity';
import { Workspace } from '../../workspace/entities/workspace.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true })
  email!: string;

  @Column({ name: 'password_hash', type: 'varchar', nullable: true })
  passwordHash!: string | null;

  @Column({
    name: 'fluxa_tenant_id',
    type: 'varchar',
    nullable: true,
    unique: true,
  })
  fluxaTenantId!: string | null;

  /** Whether the user has clicked the verification link in their email */
  @Column({ name: 'email_verified', type: 'boolean', default: false })
  emailVerified!: boolean;

  /** SHA-256 hash of the opaque verification token sent in the email (null once used) */
  @Column({ name: 'email_verification_token', type: 'varchar', nullable: true })
  emailVerificationToken!: string | null;

  /** When the verification token expires (24 hours after registration) */
  @Column({
    name: 'email_verification_expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  emailVerificationExpiresAt!: Date | null;

  /** SHA-256 hash of the opaque reset token sent in the email (null once used) */
  @Column({ name: 'password_reset_token', type: 'varchar', nullable: true })
  passwordResetToken!: string | null;

  /** When the password reset token expires (30 minutes after request) */
  @Column({
    name: 'password_reset_expires_at',
    type: 'timestamptz',
    nullable: true,
  })
  passwordResetExpiresAt!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @OneToMany(() => RefreshToken, (token) => token.user)
  refreshTokens!: RefreshToken[];

  @OneToMany(() => Workspace, (workspace) => workspace.user)
  workspaces!: Workspace[];

  @OneToMany(() => ApiKey, (apiKey) => apiKey.user)
  apiKeys!: ApiKey[];

  @OneToMany(() => ConnectedAccount, (account) => account.user)
  connectedAccounts!: ConnectedAccount[];

  @OneToMany(() => VaultKey, (key) => key.user)
  vaultKeys!: VaultKey[];
}
