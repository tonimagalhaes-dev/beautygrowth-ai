import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { DeletionStatus } from '../interfaces/privacy-service.interface';

@Entity('deletion_requests')
export class DeletionRequest {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'subject_id', type: 'varchar', length: 255 })
  subjectId: string;

  @Column({ name: 'deleted_from', type: 'jsonb', default: '[]' })
  deletedFrom: string[];

  @CreateDateColumn({ name: 'requested_at', type: 'timestamptz' })
  requestedAt: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;

  @Column({ name: 'deadline', type: 'timestamptz' })
  deadline: Date;

  @Column({
    type: 'enum',
    enum: ['completed', 'in_progress', 'failed'],
    default: 'in_progress',
  })
  status: DeletionStatus;
}
