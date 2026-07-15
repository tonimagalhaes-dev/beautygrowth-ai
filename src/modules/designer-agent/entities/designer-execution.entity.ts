import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export type DesignerExecutionStatus =
  | 'processing'
  | 'generated'
  | 'guardrail_blocked'
  | 'error';

@Entity('designer_executions')
export class DesignerExecution {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'execution_id', type: 'uuid', unique: true })
  executionId: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'content_execution_id', type: 'uuid', nullable: true })
  contentExecutionId: string | null;

  @Column({ name: 'status', type: 'varchar', length: 50, default: 'processing' })
  status: DesignerExecutionStatus;

  @Column({ name: 'descricao_visual', type: 'text' })
  descricaoVisual: string;

  @Column({ name: 'redes_sociais', type: 'text', array: true })
  redesSociais: string[];

  @Column({ name: 'estilo_visual_adicional', type: 'text', nullable: true })
  estiloVisualAdicional: string | null;

  @Column({ name: 'aplicar_logo_overlay', type: 'boolean', default: false })
  aplicarLogoOverlay: boolean;

  @Column({ name: 'logo_overlay_aplicado', type: 'boolean', default: false })
  logoOverlayAplicado: boolean;

  @Column({ name: 'version', type: 'int', default: 1 })
  version: number;

  @Column({ name: 'modelo_utilizado', type: 'varchar', length: 255, nullable: true })
  modeloUtilizado: string | null;

  @Column({ name: 'usou_fallback', type: 'boolean', default: false })
  usouFallback: boolean;

  @Column({ name: 'tokens_consumidos', type: 'int', default: 0 })
  tokensConsumidos: number;

  @Column({ name: 'duracao_ms', type: 'int', nullable: true })
  duracaoMs: number | null;

  @Column({ name: 'guardrail_violations', type: 'jsonb', default: '[]' })
  guardrailViolations: Record<string, any>[];

  @Column({ name: 'warnings', type: 'text', array: true, default: '{}' })
  warnings: string[];

  @Column({ name: 'brand_identity_defaults_used', type: 'boolean', default: false })
  brandIdentityDefaultsUsed: boolean;

  @Column({ name: 'trace_id', type: 'uuid', nullable: true })
  traceId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt: Date | null;
}
