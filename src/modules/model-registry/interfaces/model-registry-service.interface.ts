import { AIModel, ModelCapability, ModelProvider, ModelStatus } from '../entities/ai-model.entity';

export interface ModelFilters {
  provider?: ModelProvider;
  status?: ModelStatus;
  capability?: ModelCapability;
}

export interface ModelHealth {
  modelId: string;
  isAvailable: boolean;
  latencyMs?: number;
  lastCheckedAt: Date;
  errorMessage?: string;
}

export interface TokenUsageInput {
  inputTokens: number;
  outputTokens: number;
  agentId: string;
  timestamp?: Date;
}

export interface IModelRegistryService {
  list(filters?: ModelFilters): Promise<AIModel[]>;
  getById(modelId: string): Promise<AIModel>;
  getAvailableForTenant(tenantId: string): Promise<AIModel[]>;
  enableForTenant(tenantId: string, modelId: string): Promise<void>;
  disableForTenant(tenantId: string, modelId: string): Promise<void>;
  checkAvailability(modelId: string): Promise<ModelHealth>;
  getFallback(modelId: string): Promise<AIModel | null>;
  trackUsage(tenantId: string, modelId: string, usage: TokenUsageInput): Promise<void>;
}
