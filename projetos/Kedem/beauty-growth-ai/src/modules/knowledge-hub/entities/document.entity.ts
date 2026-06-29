import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export type DocumentFormat = 'pdf' | 'docx' | 'txt' | 'md';
export type DocumentStatus = 'pending' | 'processing' | 'processed' | 'error';

@Entity('documents')
export class Document {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'file_name', type: 'varchar', length: 255 })
  fileName: string;

  @Column({ type: 'enum', enum: ['pdf', 'docx', 'txt', 'md'] })
  format: DocumentFormat;

  @Column({ name: 'size_bytes', type: 'int' })
  sizeBytes: number;

  @Column({ type: 'varchar', length: 100 })
  category: string;

  @Column({
    type: 'enum',
    enum: ['pending', 'processing', 'processed', 'error'],
    default: 'pending',
  })
  status: DocumentStatus;

  @Column({ name: 'chunks_count', type: 'int', default: 0 })
  chunksCount: number;

  @Column({ name: 'storage_key', type: 'varchar', length: 512 })
  storageKey: string;

  @CreateDateColumn({ name: 'uploaded_at', type: 'timestamptz' })
  uploadedAt: Date;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @Column({ name: 'uploaded_by', type: 'uuid' })
  uploadedBy: string;

  @Column({ name: 'error_message', type: 'text', nullable: true })
  errorMessage: string | null;
}
