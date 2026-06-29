import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export interface ColorEntry {
  hex: string; // #RRGGBB
  name: string;
  isPrimary: boolean;
}

@Entity('brand_identities')
export class BrandIdentity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'voice_tone', type: 'text' })
  voiceTone: string;

  @Column({ name: 'color_palette', type: 'jsonb' })
  colorPalette: ColorEntry[];

  @Column({ name: 'logo_url', type: 'varchar', length: 500, nullable: true })
  logoUrl: string | null;

  @Column({ name: 'target_audience', type: 'text' })
  targetAudience: string;

  @Column({ type: 'text', array: true })
  differentials: string[];

  @Column({ name: 'values', type: 'text', array: true })
  values: string[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
