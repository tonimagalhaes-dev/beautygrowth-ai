import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { RedeSocial } from '../../content-agent/dto/generate-briefing.dto';

@Entity('prompt_cache_entries')
@Index(['tenantId', 'fingerprint'], { unique: true })
@Index(['tenantId', 'createdAt'])
export class PromptCacheEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'execution_id', type: 'uuid' })
  executionId: string;

  // --- Prompt Parameters (original input) ---

  @Column({ name: 'tema', type: 'text' })
  tema: string;

  @Column({ name: 'procedimento', type: 'uuid', nullable: true })
  procedimento: string | null;

  @Column({ name: 'publico_alvo_override', type: 'varchar', length: 300, nullable: true })
  publicoAlvoOverride: string | null;

  @Column({ name: 'redes_sociais', type: 'text', array: true })
  redesSociais: RedeSocial[];

  @Column({ name: 'idioma', type: 'varchar', length: 10, default: 'pt-BR' })
  idioma: string;

  // --- Fingerprint ---

  @Column({ name: 'fingerprint', type: 'varchar', length: 64 })
  fingerprint: string;

  @Column({ name: 'normalized_tema', type: 'text' })
  normalizedTema: string;

  // --- Cached Response ---

  @Column({ name: 'response_payload', type: 'jsonb' })
  responsePayload: Record<string, any>;

  @Column({ name: 'image_references', type: 'jsonb', default: '[]' })
  imageReferences: Array<{ imageId: string; url: string; redeSocial: string }>;

  // --- Metadata ---

  @Column({ name: 'tokens_consumed_input', type: 'int', default: 0 })
  tokensConsumedInput: number;

  @Column({ name: 'tokens_consumed_output', type: 'int', default: 0 })
  tokensConsumedOutput: number;

  @Column({ name: 'modelo_utilizado', type: 'varchar', length: 255 })
  modeloUtilizado: string;

  @Column({ name: 'hit_count', type: 'int', default: 0 })
  hitCount: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
