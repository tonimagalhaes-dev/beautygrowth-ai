import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

export interface Address {
  street?: string;
  number?: string;
  complement?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}

@Entity('clinics')
export class Clinic {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 20 })
  phone: string;

  @Column({ type: 'varchar', length: 320 })
  email: string;

  @Column({ type: 'text', array: true, default: '{}' })
  specialties: string[];

  @Column({ name: 'target_audience', type: 'text', nullable: true })
  targetAudience: string;

  @Column({ type: 'jsonb', nullable: true })
  address: Address | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  website: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @VersionColumn()
  version: number;
}
