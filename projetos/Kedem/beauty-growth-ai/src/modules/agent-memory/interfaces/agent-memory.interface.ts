/**
 * Interfaces for the Agent Memory Module.
 *
 * Defines the contract for agent memory operations including
 * short-term (last 50 interactions) and long-term (consolidated learnings) memory.
 */

export interface Interaction {
  id: string;
  agentId: string;
  tenantId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface LongTermEntry {
  id: string;
  agentId: string;
  tenantId: string;
  type: 'learning' | 'pattern' | 'preference';
  summary: string;
  confidence: number; // 0.0 - 1.0
  createdAt: Date;
  sourceInteractions: string[];
}

export interface AgentMemoryMetadata {
  agentId: string;
  tenantId: string;
  shortTermCount: number;
  longTermCount: number;
  lastInteractionAt: Date | null;
}

export interface AgentContext {
  shortTerm: Interaction[];
  longTerm: LongTermEntry[];
  metadata: AgentMemoryMetadata;
}

export interface ClearOptions {
  type: 'all' | 'short_term' | 'long_term';
  period?: { start: Date; end: Date };
  requireConfirmation: boolean;
}

export interface IAgentMemoryService {
  loadContext(agentId: string, tenantId: string): Promise<AgentContext>;
  persistInteraction(agentId: string, interaction: Omit<Interaction, 'id'>): Promise<void>;
  promoteToLongTerm(agentId: string): Promise<void>;
  clearMemory(agentId: string, options: ClearOptions): Promise<void>;
  getShortTermMemory(agentId: string): Promise<Interaction[]>;
  getLongTermMemory(agentId: string): Promise<LongTermEntry[]>;
}
