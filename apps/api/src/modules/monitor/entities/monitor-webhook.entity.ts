import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../auth/entities/user.entity';

@Entity('monitor_webhooks')
@Index('UQ_monitor_webhooks_user', ['userId'], { unique: true })
export class MonitorWebhook {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  @Column({ length: 2048 })
  url!: string;

  @Column({ type: 'text', select: false })
  secret!: string;

  @Column({ type: 'text', select: false, nullable: true })
  iv!: string | null;

  @Column({ name: 'auth_tag', type: 'text', select: false, nullable: true })
  authTag!: string | null;

  /**
   * 1 = legacy scheme (secret stored as plaintext).
   * 2 = AES-256-GCM ciphertext, per-user key derived from ENCRYPTION_SECRET.
   * Legacy rows are transparently re-encrypted to version 2 on first read.
   */
  @Column({ name: 'secret_version', default: 1 })
  secretVersion!: number;

  @Column({ default: true })
  enabled!: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
