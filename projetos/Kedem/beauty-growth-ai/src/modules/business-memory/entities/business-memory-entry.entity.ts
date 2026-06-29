import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

export type MemoryCategory = 'brand' | 'audience' | 'campaigns' | 'procedures' | 'preferences';

@Entity('business_memory_entries')
export class BusinessMemoryEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({
    type: 'enum',
    enum: ['brand', 'audience', 'campaigns', 'procedures', 'preferences'],
  })
  category: MemoryCategory;

  @Column({ type: 'varchar', length: 255 })
  key: string;

  @Column({ type: 'jsonb' })
  value: any;

  @Column({ type: 'int', default: 1 })
  version: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'varchar', length: 255 })
  updatedBy: string;
}
