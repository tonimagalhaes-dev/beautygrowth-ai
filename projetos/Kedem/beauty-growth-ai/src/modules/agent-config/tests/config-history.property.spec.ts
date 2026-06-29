import * as fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';
import { AgentConfigService, AGENT_DEFAULTS } from '../services/agent-config.service';
import { AgentConfig } from '../entities/agent-config.entity';
import { ConfigChange } from '../entities/config-change.entity';
import { UpdateAgentConfigDto } from '../dto/update-agent-config.dto';

/**
 * Property 8: Histórico de Configuração Completo
 *
 * Generate N configuration changes, verify exactly N history records with correct fields.
 * Each ConfigChange has: agentId, tenantId, userId, field, previousValue, newValue, changedAt.
 *
 * **Validates: Requirements 5.6**
 */

// ----- In-memory repository mocks -----

function createMockAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  const config: AgentConfig = {
    id: uuidv4(),
    tenantId: uuidv4(),
    agentType: 'content',
    status: 'inactive',
    modelId: null,
    temperature: AGENT_DEFAULTS.temperature,
    maxTokens: AGENT_DEFAULTS.maxTokens,
    systemPromptId: null,
    knowledgeCategories: [...AGENT_DEFAULTS.knowledgeCategories],
    fallbackModelId: null,
    lastExecutedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  return config;
}

interface MockAgentConfigRepo {
  agent: AgentConfig;
  findOne: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
  create: jest.Mock;
  manager: { query: jest.Mock };
}

interface MockConfigChangeRepo {
  records: ConfigChange[];
  create: jest.Mock;
  save: jest.Mock;
  find: jest.Mock;
}

function createMockRepos(agent: AgentConfig) {
  const configChangeRecords: ConfigChange[] = [];

  const agentConfigRepo: MockAgentConfigRepo = {
    agent,
    findOne: jest.fn().mockImplementation(async () => ({ ...agent })),
    save: jest.fn().mockImplementation(async (entity: AgentConfig) => {
      // Update our reference agent with the new values
      Object.assign(agent, entity);
      return { ...agent };
    }),
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((data) => ({ ...data })),
    manager: {
      query: jest.fn().mockResolvedValue([]),
    },
  };

  const configChangeRepo: MockConfigChangeRepo = {
    records: configChangeRecords,
    create: jest.fn().mockImplementation((data) => {
      const record: ConfigChange = {
        id: uuidv4(),
        agentId: data.agentId,
        tenantId: data.tenantId,
        userId: data.userId,
        field: data.field,
        previousValue: data.previousValue,
        newValue: data.newValue,
        changedAt: new Date(),
      };
      return record;
    }),
    save: jest.fn().mockImplementation(async (records: ConfigChange | ConfigChange[]) => {
      const arr = Array.isArray(records) ? records : [records];
      configChangeRecords.push(...arr);
      return arr;
    }),
    find: jest.fn().mockImplementation(async () => configChangeRecords),
  };

  return { agentConfigRepo, configChangeRepo, configChangeRecords };
}

function createService(agentConfigRepo: MockAgentConfigRepo, configChangeRepo: MockConfigChangeRepo) {
  return new AgentConfigService(
    agentConfigRepo as any,
    configChangeRepo as any,
  );
}

// ----- Arbitraries -----

// Generate a UUID-like string for use in DTO fields
const uuidArb = fc.uuid();

// Generate a temperature in valid range [0.0, 2.0]
const temperatureArb = fc.double({ min: 0.0, max: 2.0, noNaN: true });

// Generate maxTokens (positive integer)
const maxTokensArb = fc.integer({ min: 1, max: 100000 });

// Generate knowledge categories (array of strings)
const knowledgeCategoriesArb = fc.array(
  fc.constantFrom('institutional', 'procedures', 'marketing', 'faq', 'compliance', 'clinical_protocols'),
  { minLength: 0, maxLength: 6 },
);

// Generate a single update DTO with at least one field changed
const updateDtoArb = fc
  .record({
    temperature: fc.option(temperatureArb, { nil: undefined }),
    maxTokens: fc.option(maxTokensArb, { nil: undefined }),
    modelId: fc.option(uuidArb, { nil: undefined }),
    systemPromptId: fc.option(uuidArb, { nil: undefined }),
    knowledgeCategories: fc.option(knowledgeCategoriesArb, { nil: undefined }),
    fallbackModelId: fc.option(uuidArb, { nil: undefined }),
  })
  .filter((dto) => {
    // Ensure at least one field is defined
    return Object.values(dto).some((v) => v !== undefined);
  })
  .map((dto) => dto as UpdateAgentConfigDto);

// Generate N update operations (1 to 5 updates)
const updatesArb = fc.array(updateDtoArb, { minLength: 1, maxLength: 5 });

// ----- Helper: count how many fields actually change -----

function countActualChanges(agent: AgentConfig, dto: UpdateAgentConfigDto): string[] {
  const changedFields: string[] = [];

  if (dto.temperature !== undefined && dto.temperature !== agent.temperature) {
    changedFields.push('temperature');
  }
  if (dto.maxTokens !== undefined && dto.maxTokens !== agent.maxTokens) {
    changedFields.push('maxTokens');
  }
  if (dto.modelId !== undefined && dto.modelId !== agent.modelId) {
    changedFields.push('modelId');
  }
  if (dto.systemPromptId !== undefined && dto.systemPromptId !== agent.systemPromptId) {
    changedFields.push('systemPromptId');
  }
  if (dto.knowledgeCategories !== undefined) {
    const oldSorted = [...agent.knowledgeCategories].sort();
    const newSorted = [...dto.knowledgeCategories].sort();
    if (JSON.stringify(oldSorted) !== JSON.stringify(newSorted)) {
      changedFields.push('knowledgeCategories');
    }
  }
  if (dto.fallbackModelId !== undefined && dto.fallbackModelId !== agent.fallbackModelId) {
    changedFields.push('fallbackModelId');
  }

  return changedFields;
}

// ----- Tests -----

describe('Property 8: Histórico de Configuração Completo', () => {
  it('should record exactly N history records for N field changes across updates', async () => {
    await fc.assert(
      fc.asyncProperty(updatesArb, async (updates) => {
        // Setup
        const agent = createMockAgentConfig();
        const { agentConfigRepo, configChangeRepo, configChangeRecords } = createMockRepos(agent);
        const service = createService(agentConfigRepo, configChangeRepo);
        const userId = uuidv4();

        // Track expected total field changes
        let expectedTotalChanges = 0;

        // Apply each update sequentially, counting actual field changes
        for (const dto of updates) {
          // Get current agent state for change detection
          const currentState = { ...agent };
          const changedFields = countActualChanges(currentState, dto);
          expectedTotalChanges += changedFields.length;

          // The findOne mock needs to return current state
          agentConfigRepo.findOne.mockResolvedValueOnce({ ...agent });

          await service.update(agent.id, dto, userId);
        }

        // Verify: number of history records equals total field changes
        expect(configChangeRecords.length).toBe(expectedTotalChanges);
      }),
      { numRuns: 100 },
    );
  });

  it('should record correct field name, previousValue, and newValue for each change', async () => {
    await fc.assert(
      fc.asyncProperty(updateDtoArb, async (dto) => {
        // Setup with known initial values
        const agent = createMockAgentConfig({
          temperature: 0.5,
          maxTokens: 1024,
          modelId: uuidv4(),
          systemPromptId: uuidv4(),
          knowledgeCategories: ['procedures', 'faq'],
          fallbackModelId: uuidv4(),
        });
        const { agentConfigRepo, configChangeRepo, configChangeRecords } = createMockRepos(agent);
        const service = createService(agentConfigRepo, configChangeRepo);
        const userId = uuidv4();

        // Capture state before update
        const stateBefore = {
          temperature: agent.temperature,
          maxTokens: agent.maxTokens,
          modelId: agent.modelId,
          systemPromptId: agent.systemPromptId,
          knowledgeCategories: [...agent.knowledgeCategories],
          fallbackModelId: agent.fallbackModelId,
        };

        agentConfigRepo.findOne.mockResolvedValueOnce({ ...agent });
        await service.update(agent.id, dto, userId);

        // Verify each record has correct previousValue and newValue
        for (const record of configChangeRecords) {
          expect(record.field).toBeDefined();
          expect(typeof record.field).toBe('string');

          const field = record.field as keyof typeof stateBefore;
          expect(record.previousValue).toEqual(stateBefore[field]);
          expect(record.newValue).toEqual((dto as any)[field]);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('should record correct agentId, tenantId, and userId on each history record', async () => {
    await fc.assert(
      fc.asyncProperty(updateDtoArb, async (dto) => {
        const agent = createMockAgentConfig();
        const { agentConfigRepo, configChangeRepo, configChangeRecords } = createMockRepos(agent);
        const service = createService(agentConfigRepo, configChangeRepo);
        const userId = uuidv4();

        agentConfigRepo.findOne.mockResolvedValueOnce({ ...agent });
        await service.update(agent.id, dto, userId);

        for (const record of configChangeRecords) {
          expect(record.agentId).toBe(agent.id);
          expect(record.tenantId).toBe(agent.tenantId);
          expect(record.userId).toBe(userId);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('should populate changedAt on every history record', async () => {
    await fc.assert(
      fc.asyncProperty(updateDtoArb, async (dto) => {
        const agent = createMockAgentConfig();
        const { agentConfigRepo, configChangeRepo, configChangeRecords } = createMockRepos(agent);
        const service = createService(agentConfigRepo, configChangeRepo);
        const userId = uuidv4();

        agentConfigRepo.findOne.mockResolvedValueOnce({ ...agent });
        await service.update(agent.id, dto, userId);

        for (const record of configChangeRecords) {
          expect(record.changedAt).toBeInstanceOf(Date);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('should create zero history records when no fields actually change', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (n) => {
        // Setup agent with default values
        const agent = createMockAgentConfig();
        const { agentConfigRepo, configChangeRepo, configChangeRecords } = createMockRepos(agent);
        const service = createService(agentConfigRepo, configChangeRepo);
        const userId = uuidv4();

        // Update with the same values (no actual change)
        const noChangeDto: UpdateAgentConfigDto = {
          temperature: agent.temperature,
          maxTokens: agent.maxTokens,
        };

        for (let i = 0; i < n; i++) {
          agentConfigRepo.findOne.mockResolvedValueOnce({ ...agent });
          await service.update(agent.id, noChangeDto, userId);
        }

        // No actual changes → no history records
        expect(configChangeRecords.length).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});
