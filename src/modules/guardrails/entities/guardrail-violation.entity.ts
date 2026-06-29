import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export type ViolationAction = 'blocked' | 'regenerated' | 'warned';

@Entity('guardrail_violations')
export class GuardrailViolation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'guardrail_id', type: 'uuid' })
  guardrailId: string;

  @Column({ name: 'guardrail_name', type: 'varchar', length: 255 })
  guardrailName: string;

  @Column({ name: 'agent_id', type: 'uuid', nullable: true })
  agentId: string | null;

  @Column({ name: 'original_content', type: 'text' })
  originalContent: string;

  @Column({ name: 'matched_content', type: 'text' })
  matchedContent: string;

  @Column({ type: 'varchar', length: 50 })
  severity: 'critical' | 'high' | 'medium';

  @Column({ name: 'action_taken', type: 'varchar', length: 50 })
  actionTaken: ViolationAction;

  @Column({ type: 'int', default: 1 })
  attempt: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
