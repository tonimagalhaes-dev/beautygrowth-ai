import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { RedeSocial } from '../dto/generate-image.dto';

@Entity('designer_edit_history')
export class DesignerEditHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'execution_id', type: 'uuid' })
  executionId: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'rede_social', type: 'varchar', length: 20 })
  redeSocial: RedeSocial;

  @Column({ name: 'version', type: 'int' })
  version: number;

  @Column({ name: 'instrucao_edicao', type: 'text' })
  instrucaoEdicao: string;

  @Column({ name: 'prompt_visual_utilizado', type: 'text' })
  promptVisualUtilizado: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
