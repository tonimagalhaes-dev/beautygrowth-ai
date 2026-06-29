import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
  CreateDateColumn,
} from 'typeorm';
import { RetentionRule } from '../interfaces/privacy-service.interface';

@Entity('retention_policies')
export class RetentionPolicyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid', unique: true })
  tenantId: string;

  @Column({ name: 'lead_data_months', type: 'int', default: 12 })
  leadDataMonths: number;

  @Column({ name: 'financial_data_years', type: 'int', default: 5 })
  financialDataYears: number;

  @Column({ name: 'audit_log_months', type: 'int', default: 12 })
  auditLogMonths: number;

  @Column({ name: 'custom_rules', type: 'jsonb', default: '[]' })
  customRules: RetentionRule[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
