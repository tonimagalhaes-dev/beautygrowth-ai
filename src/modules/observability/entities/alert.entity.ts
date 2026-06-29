import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

export type AlertType = 'error_rate_high';

/**
 * Alert entity for tracking triggered alerts.
 */
@Entity('alerts')
@Index('idx_alert_tenant_time', ['tenantId', 'triggeredAt'])
export class AlertEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  @Column({ name: 'alert_type', type: 'varchar', length: 100 })
  alertType: AlertType;

  @Column({ type: 'float' })
  threshold: number;

  @Column({ name: 'current_value', type: 'float' })
  currentValue: number;

  @Column({ type: 'text' })
  message: string;

  @CreateDateColumn({ name: 'triggered_at', type: 'timestamptz' })
  triggeredAt: Date;
}
