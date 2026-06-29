import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type AuditLogStatus = 'success' | 'error';

/**
 * Immutable audit log entity.
 * The database has a `prevent_modification()` trigger that blocks UPDATE/DELETE.
 * The service ONLY performs INSERT operations on this table.
 */
@Entity('audit_logs')
@Index('idx_audit_log_tenant_time', ['tenantId', 'createdAt'])
@Index('idx_audit_log_trace', ['traceId'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'trace_id', type: 'varchar', length: 255 })
  traceId: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'agent_id', type: 'uuid', nullable: true })
  agentId: string | null;

  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'action_type', type: 'varchar', length: 255 })
  actionType: string;

  @Column({ type: 'text', default: '' })
  input: string;

  @Column({ type: 'text', default: '' })
  output: string;

  @Column({ name: 'duration_ms', type: 'int', default: 0 })
  durationMs: number;

  @Column({ type: 'enum', enum: ['success', 'error'], default: 'success' })
  status: AuditLogStatus;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
