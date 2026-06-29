import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export type AgentType = 'content' | 'campaigns' | 'customer_service';
export type AgentStatus = 'active' | 'inactive' | 'configuring';

@Entity('agent_configs')
export class AgentConfig {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ name: 'agent_type', type: 'enum', enum: ['content', 'campaigns', 'customer_service'] })
  agentType: AgentType;

  @Column({ type: 'enum', enum: ['active', 'inactive', 'configuring'], default: 'configuring' })
  status: AgentStatus;

  @Column({ name: 'model_id', type: 'uuid', nullable: true })
  modelId: string | null;

  @Column({ type: 'float', default: 0.7 })
  temperature: number;

  @Column({ name: 'max_tokens', type: 'int', default: 2048 })
  maxTokens: number;

  @Column({ name: 'system_prompt_id', type: 'uuid', nullable: true })
  systemPromptId: string | null;

  @Column({ name: 'knowledge_categories', type: 'text', array: true, default: '{}' })
  knowledgeCategories: string[];

  @Column({ name: 'fallback_model_id', type: 'uuid', nullable: true })
  fallbackModelId: string | null;

  @Column({ name: 'last_executed_at', type: 'timestamptz', nullable: true })
  lastExecutedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
