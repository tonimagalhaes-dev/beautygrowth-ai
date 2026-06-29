import { ModelCapability, ModelProvider, ModelStatus } from '../entities/ai-model.entity';

/**
 * Predefined model catalog for 6 providers.
 * Used for seeding the ai_models table and for reference in tests.
 */
export interface ModelCatalogEntry {
  provider: ModelProvider;
  name: string;
  version: string;
  capabilities: ModelCapability[];
  costPerInputToken: number;
  costPerOutputToken: number;
  contextWindow: number;
  status: ModelStatus;
  maxTemperature: number;
  maxOutputTokens: number;
}

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  // OpenAI
  {
    provider: 'openai',
    name: 'GPT-4o',
    version: '2024-05-13',
    capabilities: ['text_generation', 'vision', 'function_calling'],
    costPerInputToken: 0.000005,
    costPerOutputToken: 0.000015,
    contextWindow: 128000,
    status: 'available',
    maxTemperature: 2.0,
    maxOutputTokens: 4096,
  },
  {
    provider: 'openai',
    name: 'GPT-4o-mini',
    version: '2024-07-18',
    capabilities: ['text_generation', 'vision', 'function_calling'],
    costPerInputToken: 0.00000015,
    costPerOutputToken: 0.0000006,
    contextWindow: 128000,
    status: 'available',
    maxTemperature: 2.0,
    maxOutputTokens: 16384,
  },
  {
    provider: 'openai',
    name: 'text-embedding-3-large',
    version: '2024-01-25',
    capabilities: ['embeddings'],
    costPerInputToken: 0.00000013,
    costPerOutputToken: 0,
    contextWindow: 8191,
    status: 'available',
    maxTemperature: 0,
    maxOutputTokens: 0,
  },

  // Anthropic
  {
    provider: 'anthropic',
    name: 'Claude 3.5 Sonnet',
    version: '2024-06-20',
    capabilities: ['text_generation', 'vision', 'function_calling'],
    costPerInputToken: 0.000003,
    costPerOutputToken: 0.000015,
    contextWindow: 200000,
    status: 'available',
    maxTemperature: 1.0,
    maxOutputTokens: 8192,
  },
  {
    provider: 'anthropic',
    name: 'Claude 3 Haiku',
    version: '2024-03-07',
    capabilities: ['text_generation', 'vision', 'function_calling'],
    costPerInputToken: 0.00000025,
    costPerOutputToken: 0.00000125,
    contextWindow: 200000,
    status: 'available',
    maxTemperature: 1.0,
    maxOutputTokens: 4096,
  },

  // Google
  {
    provider: 'google',
    name: 'Gemini 1.5 Pro',
    version: '2024-05-01',
    capabilities: ['text_generation', 'vision', 'function_calling'],
    costPerInputToken: 0.0000035,
    costPerOutputToken: 0.0000105,
    contextWindow: 1000000,
    status: 'available',
    maxTemperature: 2.0,
    maxOutputTokens: 8192,
  },
  {
    provider: 'google',
    name: 'Gemini 1.5 Flash',
    version: '2024-05-01',
    capabilities: ['text_generation', 'vision', 'function_calling'],
    costPerInputToken: 0.00000035,
    costPerOutputToken: 0.00000105,
    contextWindow: 1000000,
    status: 'available',
    maxTemperature: 2.0,
    maxOutputTokens: 8192,
  },

  // Meta
  {
    provider: 'meta',
    name: 'Llama 3.1 405B',
    version: '2024-07-23',
    capabilities: ['text_generation', 'function_calling'],
    costPerInputToken: 0.000003,
    costPerOutputToken: 0.000003,
    contextWindow: 128000,
    status: 'available',
    maxTemperature: 2.0,
    maxOutputTokens: 4096,
  },
  {
    provider: 'meta',
    name: 'Llama 3.1 70B',
    version: '2024-07-23',
    capabilities: ['text_generation', 'function_calling'],
    costPerInputToken: 0.0000009,
    costPerOutputToken: 0.0000009,
    contextWindow: 128000,
    status: 'available',
    maxTemperature: 2.0,
    maxOutputTokens: 4096,
  },

  // Alibaba
  {
    provider: 'alibaba',
    name: 'Qwen2-72B',
    version: '2024-06-01',
    capabilities: ['text_generation', 'function_calling'],
    costPerInputToken: 0.0000012,
    costPerOutputToken: 0.0000012,
    contextWindow: 128000,
    status: 'available',
    maxTemperature: 2.0,
    maxOutputTokens: 4096,
  },
  {
    provider: 'alibaba',
    name: 'Qwen-VL-Max',
    version: '2024-04-01',
    capabilities: ['text_generation', 'vision'],
    costPerInputToken: 0.000002,
    costPerOutputToken: 0.000002,
    contextWindow: 32000,
    status: 'testing',
    maxTemperature: 1.5,
    maxOutputTokens: 2048,
  },

  // DeepSeek
  {
    provider: 'deepseek',
    name: 'DeepSeek-V2',
    version: '2024-05-01',
    capabilities: ['text_generation', 'function_calling'],
    costPerInputToken: 0.00000014,
    costPerOutputToken: 0.00000028,
    contextWindow: 128000,
    status: 'available',
    maxTemperature: 2.0,
    maxOutputTokens: 4096,
  },
  {
    provider: 'deepseek',
    name: 'DeepSeek-Coder-V2',
    version: '2024-06-01',
    capabilities: ['text_generation', 'function_calling'],
    costPerInputToken: 0.00000014,
    costPerOutputToken: 0.00000028,
    contextWindow: 128000,
    status: 'available',
    maxTemperature: 2.0,
    maxOutputTokens: 4096,
  },
];
