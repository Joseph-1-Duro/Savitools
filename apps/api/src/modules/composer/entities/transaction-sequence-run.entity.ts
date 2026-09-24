import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('transaction_sequence_run')
export class TransactionSequenceRun {
  @PrimaryColumn('uuid')
  id: string;

  @Column()
  network: string;

  @Column({ name: 'stop_on_failure' })
  stopOnFailure: boolean;

  @Column()
  status: string;

  @Column({ type: 'jsonb' })
  steps: any[];

  @Column({ type: 'jsonb', nullable: true })
  results: any[] | null;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
