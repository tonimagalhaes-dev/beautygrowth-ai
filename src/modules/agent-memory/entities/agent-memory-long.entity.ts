import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

export type LongTermEntryType = 'learning' | 'pattern' | 'preference';

@Entity('agent_memory_long')
export class AgentMemoryLong {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId: string;

  @Column({ type: 'enum', enum: ['learning', 'pattern', 'preference'] })
  type: LongTermEntryType;

  @Column({ type: 'text' })
  summary: string;

  @Column({ type: 'float' })
  confidence: number;

  @Column({ name: 'source_interactions', type: 'uuid', array: true, default: '{}' })
  sourceInteractions: string[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
