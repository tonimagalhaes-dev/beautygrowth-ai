import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('ropa_records')
export class ROPARecordEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'processing_activity', type: 'varchar', length: 500 })
  processingActivity: string;

  @Column({ type: 'varchar', length: 500 })
  purpose: string;

  @Column({ name: 'data_categories', type: 'jsonb', default: '[]' })
  dataCategories: string[];

  @Column({ name: 'data_subjects', type: 'jsonb', default: '[]' })
  dataSubjects: string[];

  @Column({ type: 'jsonb', default: '[]' })
  recipients: string[];

  @Column({ name: 'retention_period', type: 'varchar', length: 255 })
  retentionPeriod: string;

  @Column({ name: 'security_measures', type: 'jsonb', default: '[]' })
  securityMeasures: string[];

  @Column({ name: 'legal_basis', type: 'varchar', length: 255 })
  legalBasis: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
