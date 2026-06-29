import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { PromptVersion } from './prompt-version.entity';

export type AgentType = 'content' | 'campaigns' | 'customer_service';
export type PromptFunction = 'system' | 'task' | 'formatting';

@Entity('prompts')
export class Prompt {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'agent_type', type: 'enum', enum: ['content', 'campaigns', 'customer_service'] })
  agentType: AgentType;

  @Column({ name: 'function', type: 'enum', enum: ['system', 'task', 'formatting'] })
  function: PromptFunction;

  @Column({ name: 'active_version', type: 'varchar', nullable: true })
  activeVersion: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @OneToMany(() => PromptVersion, (version) => version.prompt)
  versions: PromptVersion[];
}
