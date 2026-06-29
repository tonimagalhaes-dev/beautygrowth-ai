import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { GuardrailRule } from '../interfaces/guardrails-service.interface';

/**
 * Stores historical versions of tenant guardrails for rollback support.
 */
@Entity('guardrail_versions')
export class GuardrailVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'guardrail_id', type: 'uuid' })
  guardrailId: string;

  @Column({ type: 'int' })
  version: number;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'jsonb' })
  rule: GuardrailRule;

  @Column({ name: 'is_active', type: 'boolean' })
  isActive: boolean;

  @Column({ name: 'changed_by', type: 'uuid', nullable: true })
  changedBy: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
