import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentConfigService, AGENT_DEFAULTS } from '../services/agent-config.service';
import { AgentConfig, AgentType, AgentStatus } from '../entities/agent-config.entity';
import { ConfigChange } from '../entities/config-change.entity';

/**
 * Property 7: Reset de Agente Restaura Padrão
 *
 * For any agent configuration with arbitrary temperature, maxTokens, and knowledgeCategories,
 * calling resetToDefaults() MUST restore temperature to 0.7, maxTokens to 2048, and
 * knowledgeCategories to []. Other fields (modelId, systemPromptId, fallbackModelId, status)
 * MUST NOT be modified by the reset operation.
 *
 * **Validates: Requirements 5.7**
 */

// -- Arbitraries --

/** Random temperature in valid range [0.0, 2.0] */
const temperatureArb = fc.double({ min: 0.0, max: 2.0, noNaN: true });

/** Random maxTokens in [1, 10000] */
const maxTokensArb = fc.integer({ min: 1, max: 10000 });

/** Random knowledge categories (0 to 5 random category strings) */
const knowledgeCategoriesArb = fc.array(
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz_'.split('')), {
    minLength: 3,
    maxLength: 20,
  }),
  { minLength: 0, maxLength: 5 },
);

/** Random UUID-like strings for model/prompt references */
const uuidArb = fc.uuid();

/** Random nullable UUID */
const nullableUuidArb = fc.option(uuidArb, { nil: null });

/** Random agent type */
const agentTypeArb = fc.constantFrom<AgentType>('content', 'campaigns', 'customer_service');

/** Random agent status */
const agentStatusArb = fc.constantFrom<AgentStatus>('active', 'inactive', 'configuring');

/** Full agent config arbitrary (simulates a modified agent) */
const modifiedAgentArb = fc.record({
  temperature: temperatureArb,
  maxTokens: maxTokensArb,
  knowledgeCategories: knowledgeCategoriesArb,
  modelId: nullableUuidArb,
  systemPromptId: nullableUuidArb,
  fallbackModelId: nullableUuidArb,
  agentType: agentTypeArb,
  status: agentStatusArb,
});

describe('Property 7: Reset de Agente Restaura Padrão', () => {
  let service: AgentConfigService;
  let agentConfigRepo: Record<string, jest.Mock>;

  const mockAgentId = '33333333-3333-3333-3333-333333333333';
  const mockTenantId = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentConfigService,
        {
          provide: getRepositoryToken(AgentConfig),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn().mockImplementation(async (agent: any) => agent),
            manager: { query: jest.fn() },
          },
        },
        {
          provide: getRepositoryToken(ConfigChange),
          useValue: {
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AgentConfigService>(AgentConfigService);
    agentConfigRepo = module.get(getRepositoryToken(AgentConfig));
  });

  it('should restore temperature, maxTokens, and knowledgeCategories to defaults after reset', async () => {
    await fc.assert(
      fc.asyncProperty(modifiedAgentArb, async (config) => {
        const agent: AgentConfig = {
          id: mockAgentId,
          tenantId: mockTenantId,
          agentType: config.agentType,
          status: config.status,
          modelId: config.modelId,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          systemPromptId: config.systemPromptId,
          knowledgeCategories: [...config.knowledgeCategories],
          fallbackModelId: config.fallbackModelId,
          lastExecutedAt: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        };

        agentConfigRepo.findOne.mockResolvedValue(agent);

        const result = await service.resetToDefaults(mockAgentId);

        // After reset, these 3 fields MUST be the defaults
        expect(result.temperature).toBe(AGENT_DEFAULTS.temperature);
        expect(result.maxTokens).toBe(AGENT_DEFAULTS.maxTokens);
        expect(result.knowledgeCategories).toEqual(AGENT_DEFAULTS.knowledgeCategories);
      }),
      { numRuns: 100 },
    );
  });

  it('should NOT modify modelId, systemPromptId, fallbackModelId, or status on reset', async () => {
    await fc.assert(
      fc.asyncProperty(modifiedAgentArb, async (config) => {
        const agent: AgentConfig = {
          id: mockAgentId,
          tenantId: mockTenantId,
          agentType: config.agentType,
          status: config.status,
          modelId: config.modelId,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          systemPromptId: config.systemPromptId,
          knowledgeCategories: [...config.knowledgeCategories],
          fallbackModelId: config.fallbackModelId,
          lastExecutedAt: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        };

        agentConfigRepo.findOne.mockResolvedValue(agent);

        const result = await service.resetToDefaults(mockAgentId);

        // These fields MUST remain unchanged
        expect(result.modelId).toBe(config.modelId);
        expect(result.systemPromptId).toBe(config.systemPromptId);
        expect(result.fallbackModelId).toBe(config.fallbackModelId);
        expect(result.status).toBe(config.status);
        expect(result.agentType).toBe(config.agentType);
        expect(result.tenantId).toBe(mockTenantId);
        expect(result.id).toBe(mockAgentId);
      }),
      { numRuns: 100 },
    );
  });

  it('should be idempotent — resetting an already-default agent yields the same defaults', async () => {
    await fc.assert(
      fc.asyncProperty(agentTypeArb, agentStatusArb, async (agentType, status) => {
        // Agent already at defaults
        const agent: AgentConfig = {
          id: mockAgentId,
          tenantId: mockTenantId,
          agentType,
          status,
          modelId: null,
          temperature: AGENT_DEFAULTS.temperature,
          maxTokens: AGENT_DEFAULTS.maxTokens,
          systemPromptId: null,
          knowledgeCategories: [...AGENT_DEFAULTS.knowledgeCategories],
          fallbackModelId: null,
          lastExecutedAt: null,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date('2024-01-01'),
        };

        agentConfigRepo.findOne.mockResolvedValue(agent);

        const result = await service.resetToDefaults(mockAgentId);

        expect(result.temperature).toBe(AGENT_DEFAULTS.temperature);
        expect(result.maxTokens).toBe(AGENT_DEFAULTS.maxTokens);
        expect(result.knowledgeCategories).toEqual(AGENT_DEFAULTS.knowledgeCategories);
      }),
      { numRuns: 100 },
    );
  });
});
