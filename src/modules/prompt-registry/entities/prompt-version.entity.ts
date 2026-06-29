import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { Prompt } from './prompt.entity';

@Entity('prompt_versions')
export class PromptVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'prompt_id', type: 'uuid' })
  promptId: string;

  @Column({ type: 'varchar' })
  version: string; // semver: major.minor.patch

  @Column({ type: 'text' })
  content: string; // template with {{variables}}

  @Column({ type: 'text', array: true, default: '{}' })
  variables: string[]; // detected variables

  @Column({ type: 'uuid', nullable: true })
  author: string | null;

  @Column({ type: 'text', default: '' })
  description: string;

  @Column({ name: 'is_active', type: 'boolean', default: false })
  isActive: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @ManyToOne(() => Prompt, (prompt) => prompt.versions)
  @JoinColumn({ name: 'prompt_id' })
  prompt: Prompt;
}
