import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { RedeSocial } from '../dto/generate-image.dto';

@Entity('designer_images')
export class DesignerImage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'execution_id', type: 'uuid' })
  executionId: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'rede_social', type: 'varchar', length: 20 })
  redeSocial: RedeSocial;

  @Column({ name: 'aspecto_ratio', type: 'varchar', length: 10 })
  aspectoRatio: string;

  @Column({ name: 'largura_px', type: 'int' })
  larguraPx: number;

  @Column({ name: 'altura_px', type: 'int' })
  alturaPx: number;

  @Column({ name: 'tamanho_bytes', type: 'int' })
  tamanhoBytes: number;

  @Column({ name: 'formato', type: 'varchar', length: 10, default: 'PNG' })
  formato: string;

  @Column({ name: 'minio_path', type: 'text' })
  minioPath: string;

  @Column({ name: 'minio_path_thumbnail', type: 'text' })
  minioPathThumbnail: string;

  @Column({ name: 'minio_path_sem_overlay', type: 'text', nullable: true })
  minioPathSemOverlay: string | null;

  @Column({ name: 'url_presigned', type: 'text', nullable: true })
  urlPresigned: string | null;

  @Column({ name: 'url_presigned_thumbnail', type: 'text', nullable: true })
  urlPresignedThumbnail: string | null;

  @Column({ name: 'url_presigned_sem_overlay', type: 'text', nullable: true })
  urlPresignedSemOverlay: string | null;

  @Column({ name: 'url_presigned_expires_at', type: 'timestamptz', nullable: true })
  urlPresignedExpiresAt: Date | null;

  @Column({ name: 'modelo_utilizado', type: 'varchar', length: 255 })
  modeloUtilizado: string;

  @Column({ name: 'version', type: 'int', default: 1 })
  version: number;

  @Column({ name: 'is_latest', type: 'boolean', default: true })
  isLatest: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
