import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { ConsentStatus } from '../interfaces/privacy-service.interface';

@Entity('consents')
@Index('idx_consent_subject', ['tenantId', 'subjectId', 'status'])
export class Consent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'subject_id', type: 'varchar', length: 255 })
  subjectId: string;

  @Column({ type: 'varchar', length: 255 })
  purpose: string;

  @Column({ name: 'collection_method', type: 'varchar', length: 255 })
  collectionMethod: string;

  @CreateDateColumn({ name: 'granted_at', type: 'timestamptz' })
  grantedAt: Date;

  @Column({ name: 'expires_at', type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({
    type: 'enum',
    enum: ['active', 'revoked', 'expired'],
    default: 'active',
  })
  status: ConsentStatus;
}
