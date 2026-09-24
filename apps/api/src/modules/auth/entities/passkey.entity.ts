import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from './user.entity';

@Entity('passkeys')
@Index(['userId'])
export class PasskeyCredential {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  /** Human-readable label chosen by the user */
  @Column({ type: 'varchar' })
  name!: string;

  /** WebAuthn credential ID (base64url); unique across all users. */
  @Column({ name: 'credential_id', type: 'varchar', unique: true })
  credentialId!: string;

  /** COSE algorithm used by the authenticator (e.g. -7 = ES256). */
  @Column({ name: 'algorithm', type: 'int' })
  algorithm!: number;

  /** COSE public key of the credential (base64url). */
  @Column({ name: 'public_key', type: 'text' })
  publicKey!: string;

  /** Authenticator's signature counter for cloned-device detection. */
  @Column({ type: 'bigint', default: 0 })
  counter!: number;

  /** Transports the credential supports (usb/nfc/ble/internal/hybrid). */
  @Column({ type: 'json', nullable: true })
  transports!: string[] | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'last_used_at', type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;

  /** Soft revocation: revoked credentials can never authenticate again. */
  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;
}
