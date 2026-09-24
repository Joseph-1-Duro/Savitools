import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity('network_profiles')
@Unique(['ownerId', 'name'])
export class NetworkProfile {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'owner_id' })
  ownerId: string;

  @Column({ length: 120 })
  name: string;

  @Column({ name: 'horizon_url' })
  horizonUrl: string;

  @Column({ name: 'network_passphrase' })
  networkPassphrase: string;

  @Column({ name: 'friendbot_url', type: 'varchar', nullable: true })
  friendbotUrl: string | null;

  @Column({ name: 'is_default', default: false })
  isDefault: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
