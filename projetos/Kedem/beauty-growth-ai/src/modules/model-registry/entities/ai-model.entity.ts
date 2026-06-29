import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
} from 'typeorm';

export type ModelProvider = 'openai' | 'anthropic' | 'google' | 'meta' | 'alibaba' | 'deepseek';
export type ModelStatus = 'available' | 'deprecated' | 'testing';
export type ModelCapability = 'text_generation' | 'vision' | 'embeddings' | 'function_calling';

@Entity('ai_models')
export class AIModel {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: ['openai', 'anthropic', 'google', 'meta', 'alibaba', 'deepseek'],
  })
  provider: ModelProvider;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 50 })
  version: string;

  @Column({ type: 'text', array: true, default: '{}' })
  capabilities: ModelCapability[];

  @Column({ name: 'cost_input_token', type: 'decimal', precision: 12, scale: 8, default: 0 })
  costPerInputToken: number;

  @Column({ name: 'cost_output_token', type: 'decimal', precision: 12, scale: 8, default: 0 })
  costPerOutputToken: number;

  @Column({ name: 'context_window', type: 'int', default: 4096 })
  contextWindow: number;

  @Column({
    type: 'enum',
    enum: ['available', 'deprecated', 'testing'],
    default: 'available',
  })
  status: ModelStatus;

  @Column({ name: 'max_temperature', type: 'float', default: 2.0 })
  maxTemperature: number;

  @Column({ name: 'max_output_tokens', type: 'int', default: 4096 })
  maxOutputTokens: number;
}
