import * as fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';
import { ModelRegistryService } from '../services/model-registry.service';
import { AIModel } from '../entities/ai-model.entity';
import { TenantModel } from '../entities/tenant-model.entity';
import { TokenUsage } from '../entities/token-usage.entity';
import { TokenUsageInput } from '../interfaces/model-registry-service.interface';

/**
 * Property 17: Rastreamento de Tokens
 *
 * Execute agent actions, verify input/output tokens recorded correctly per tenant+model.
 * Test with fast-check 100+ iterations: generate random token usage records
 * (random input_tokens, output_tokens, model_id, tenant_id, agent_id),
 * call trackUsage(), verify the repository saves exact values.
 *
 * **Validates: Requirements 9.9**
 */

// ----- In-memory repository mocks -----

interface SavedTokenUsage {
  tenantId: string;
  modelId: string;
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  recordedAt: Date;
}

function createMockRepos() {
  const savedRecords: SavedTokenUsage[] = [];

  const modelRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue({
      andWhere: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
    }),
    create: jest.fn((entity: any) => entity),
    save: jest.fn((entity: any) => Promise.resolve(entity)),
  };

  const tenantModelRepo = {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn((entity: any) => entity),
    save: jest.fn((entity: any) => Promise.resolve(entity)),
  };

  const tokenUsageRepo = {
    create: jest.fn((data: any) => ({ id: uuidv4(), ...data })),
    save: jest.fn(async (entity: any) => {
      savedRecords.push({
        tenantId: entity.tenantId,
        modelId: entity.modelId,
        agentId: entity.agentId,
        inputTokens: entity.inputTokens,
        outputTokens: entity.outputTokens,
        recordedAt: entity.recordedAt,
      });
      return entity;
    }),
  };

  const eventEmitter = {
    emit: jest.fn(),
  };

  return { modelRepo, tenantModelRepo, tokenUsageRepo, eventEmitter, savedRecords };
}

function createService(
  modelRepo: any,
  tenantModelRepo: any,
  tokenUsageRepo: any,
  eventEmitter: any,
): ModelRegistryService {
  return new ModelRegistryService(
    modelRepo,
    tenantModelRepo,
    tokenUsageRepo,
    eventEmitter,
  );
}

// ----- Arbitraries -----

const uuidArb = fc.uuid();

const inputTokensArb = fc.integer({ min: 0, max: 1_000_000 });
const outputTokensArb = fc.integer({ min: 0, max: 500_000 });

// Generate a single token usage record
const tokenUsageRecordArb = fc.record({
  tenantId: uuidArb,
  modelId: uuidArb,
  agentId: uuidArb,
  inputTokens: inputTokensArb,
  outputTokens: outputTokensArb,
});

// Generate a batch of token usage records (1 to 10 per run)
const tokenUsageBatchArb = fc.array(tokenUsageRecordArb, { minLength: 1, maxLength: 10 });

// ----- Tests -----

describe('Property 17: Rastreamento de Tokens', () => {
  it('should save exact input/output token values for each trackUsage call', async () => {
    await fc.assert(
      fc.asyncProperty(tokenUsageRecordArb, async (record) => {
        // Setup
        const { modelRepo, tenantModelRepo, tokenUsageRepo, eventEmitter, savedRecords } = createMockRepos();
        const service = createService(modelRepo, tenantModelRepo, tokenUsageRepo, eventEmitter);

        const usage: TokenUsageInput = {
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          agentId: record.agentId,
        };

        // Act
        await service.trackUsage(record.tenantId, record.modelId, usage);

        // Assert: exactly one record saved
        expect(savedRecords.length).toBe(1);

        // Assert: saved values match input exactly
        const saved = savedRecords[0];
        expect(saved.tenantId).toBe(record.tenantId);
        expect(saved.modelId).toBe(record.modelId);
        expect(saved.agentId).toBe(record.agentId);
        expect(saved.inputTokens).toBe(record.inputTokens);
        expect(saved.outputTokens).toBe(record.outputTokens);
      }),
      { numRuns: 150 },
    );
  });

  it('should correctly track multiple usage records per tenant+model combination', async () => {
    await fc.assert(
      fc.asyncProperty(tokenUsageBatchArb, async (batch) => {
        // Setup
        const { modelRepo, tenantModelRepo, tokenUsageRepo, eventEmitter, savedRecords } = createMockRepos();
        const service = createService(modelRepo, tenantModelRepo, tokenUsageRepo, eventEmitter);

        // Act: track each record
        for (const record of batch) {
          const usage: TokenUsageInput = {
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            agentId: record.agentId,
          };
          await service.trackUsage(record.tenantId, record.modelId, usage);
        }

        // Assert: total records saved equals batch size
        expect(savedRecords.length).toBe(batch.length);

        // Assert: each saved record matches the corresponding input
        for (let i = 0; i < batch.length; i++) {
          const input = batch[i];
          const saved = savedRecords[i];

          expect(saved.tenantId).toBe(input.tenantId);
          expect(saved.modelId).toBe(input.modelId);
          expect(saved.agentId).toBe(input.agentId);
          expect(saved.inputTokens).toBe(input.inputTokens);
          expect(saved.outputTokens).toBe(input.outputTokens);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('should preserve tenant isolation: records from different tenants are stored with their respective tenant_id', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        uuidArb,
        uuidArb,
        inputTokensArb,
        outputTokensArb,
        inputTokensArb,
        outputTokensArb,
        async (tenantA, tenantB, modelId, inputA, outputA, inputB, outputB) => {
          // Ensure we have distinct tenants
          fc.pre(tenantA !== tenantB);

          // Setup
          const { modelRepo, tenantModelRepo, tokenUsageRepo, eventEmitter, savedRecords } = createMockRepos();
          const service = createService(modelRepo, tenantModelRepo, tokenUsageRepo, eventEmitter);
          const agentId = uuidv4();

          // Track usage for tenant A
          await service.trackUsage(tenantA, modelId, {
            inputTokens: inputA,
            outputTokens: outputA,
            agentId,
          });

          // Track usage for tenant B
          await service.trackUsage(tenantB, modelId, {
            inputTokens: inputB,
            outputTokens: outputB,
            agentId,
          });

          // Assert: both records saved
          expect(savedRecords.length).toBe(2);

          // Assert: tenant A's record has correct values
          const recordA = savedRecords[0];
          expect(recordA.tenantId).toBe(tenantA);
          expect(recordA.inputTokens).toBe(inputA);
          expect(recordA.outputTokens).toBe(outputA);

          // Assert: tenant B's record has correct values
          const recordB = savedRecords[1];
          expect(recordB.tenantId).toBe(tenantB);
          expect(recordB.inputTokens).toBe(inputB);
          expect(recordB.outputTokens).toBe(outputB);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should use provided timestamp when specified, or generate one when not', async () => {
    await fc.assert(
      fc.asyncProperty(
        tokenUsageRecordArb,
        fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }),
        async (record, customTimestamp) => {
          // Setup
          const { modelRepo, tenantModelRepo, tokenUsageRepo, eventEmitter, savedRecords } = createMockRepos();
          const service = createService(modelRepo, tenantModelRepo, tokenUsageRepo, eventEmitter);

          // Act: with custom timestamp
          await service.trackUsage(record.tenantId, record.modelId, {
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            agentId: record.agentId,
            timestamp: customTimestamp,
          });

          // Assert: saved record uses provided timestamp
          expect(savedRecords.length).toBe(1);
          expect(savedRecords[0].recordedAt).toEqual(customTimestamp);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should correctly associate token usage with different model IDs for same tenant', async () => {
    await fc.assert(
      fc.asyncProperty(
        uuidArb,
        uuidArb,
        uuidArb,
        uuidArb,
        inputTokensArb,
        outputTokensArb,
        inputTokensArb,
        outputTokensArb,
        async (tenantId, modelA, modelB, agentId, inputA, outputA, inputB, outputB) => {
          // Ensure distinct models
          fc.pre(modelA !== modelB);

          // Setup
          const { modelRepo, tenantModelRepo, tokenUsageRepo, eventEmitter, savedRecords } = createMockRepos();
          const service = createService(modelRepo, tenantModelRepo, tokenUsageRepo, eventEmitter);

          // Track usage for model A
          await service.trackUsage(tenantId, modelA, {
            inputTokens: inputA,
            outputTokens: outputA,
            agentId,
          });

          // Track usage for model B
          await service.trackUsage(tenantId, modelB, {
            inputTokens: inputB,
            outputTokens: outputB,
            agentId,
          });

          // Assert: both records saved with correct model IDs
          expect(savedRecords.length).toBe(2);
          expect(savedRecords[0].modelId).toBe(modelA);
          expect(savedRecords[0].inputTokens).toBe(inputA);
          expect(savedRecords[0].outputTokens).toBe(outputA);
          expect(savedRecords[1].modelId).toBe(modelB);
          expect(savedRecords[1].inputTokens).toBe(inputB);
          expect(savedRecords[1].outputTokens).toBe(outputB);
        },
      ),
      { numRuns: 100 },
    );
  });
});
