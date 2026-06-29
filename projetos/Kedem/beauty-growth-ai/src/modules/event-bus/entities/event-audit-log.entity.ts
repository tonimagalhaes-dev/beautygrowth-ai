import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('event_audit_logs')
export class EventAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'event_name', type: 'varchar' })
  eventName: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, any>;

  @Index()
  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'correlation_id', type: 'uuid' })
  correlationId: string;

  @Column({ name: 'published_at', type: 'timestamptz' })
  publishedAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date;

  @Column({ name: 'duration_ms', type: 'integer', default: 0 })
  durationMs: number;

  @Column({ type: 'varchar', length: 20 })
  status: 'success' | 'failed' | 'replayed';

  @Column({ type: 'integer', default: 1 })
  attempts: number;

  @Column({ type: 'jsonb', nullable: true })
  errors: Array<{ attempt: number; error: string; timestamp: string }>;

  @Column({ name: 'is_replay', type: 'boolean', default: false })
  isReplay: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
