import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ModelRegistryService } from '../services/model-registry.service';
import { AIModel, ModelProvider, ModelStatus, ModelCapability } from '../entities/ai-model.entity';
import { TenantModel } from '../entities/tenant-model.entity';
import { TokenUsage } from '../entities/token-usage.entity';

/**
 * Property 16: Model Registry — Fallback Automático
 *
 * For any request to an agent whose primary model is unavailable,
 * the system MUST automatically route to a fallback model AND
 * emit a 'model.fallback.activated' event for observability logging.
 *
 * Test with fast-check 100+ iterations: generate random model configurations,
 * simulate primary being deprecated/unavailable, verify getFallback() returns
 * a different model and emits 'model.fallback.activated' event.
 *
 * **Validates: Requirements 9.7**
 */

// -- Arbitraries --

const ALL_PROVIDERS: ModelProvider[] = ['openai', 'anthropic', 'google', 'meta', 'alibaba', 'deepseek'];
const UNAVAILABLE_STATUSES: ModelStatus[] = ['deprecated', 'testing'];
const ALL_CAPABILITIES: ModelCapability[] = ['text_generation', 'vision', 'embeddings', 'function_calling'];

/** Random model provider */
const providerArb = fc.constantFrom<ModelProvider>(...ALL_PROVIDERS);

/** Random unavailable status for the primary model */
const unavailableStatusArb = fc.constantFrom<ModelStatus>(...UNAVAILABLE_STATUSES);

/** Random capability set (at least 1) */
const capabilitiesArb = fc.subarray(ALL_CAPABILITIES, { minLength: 1 });

/** Random context window size */
const contextWindowArb = fc.integer({ min: 4096, max: 256000 });

/** Random model name */
const modelNameArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz-0123456789'.split('')),
  { minLength: 3, maxLength: 30 },
);

/** Random model version */
const modelVersionArb = fc.tuple(
  fc.integer({ min: 1, max: 5 }),
  fc.integer({ min: 0, max: 9 }),
).map(([major, minor]) => `${major}.${minor}`);

/** Arbitrary for a complete AIModel */
const aiModelArb = (idPrefix: string, statusOverride?: ModelStatus) =>
  fc.record({
    provider: providerArb,
    name: modelNameArb,
    version: modelVersionArb,
    capabilities: capabilitiesArb,
    contextWindow: contextWindowArb,
  }).map((fields) => ({
    id: `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    provider: fields.provider,
    name: fields.name,
    version: fields.version,
    capabilities: fields.capabilities,
    costPerInputToken: 0.000005,
    costPerOutputToken: 0.000015,
    contextWindow: fields.contextWindow,
    status: (statusOverride ?? 'available') as ModelStatus,
    maxTemperature: 2.0,
    maxOutputTokens: 4096,
  } as AIModel));

/** Arbitrary for a primary model that is unavailable */
const unavailablePrimaryArb = fc.record({
  provider: providerArb,
  name: modelNameArb,
  version: modelVersionArb,
  capabilities: capabilitiesArb,
  contextWindow: contextWindowArb,
  status: unavailableStatusArb,
}).map((fields) => ({
  id: `primary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  provider: fields.provider,
  name: fields.name,
  version: fields.version,
  capabilities: fields.capabilities,
  costPerInputToken: 0.000005,
  costPerOutputToken: 0.000015,
  contextWindow: fields.contextWindow,
  status: fields.status,
  maxTemperature: 2.0,
  maxOutputTokens: 4096,
} as AIModel));

/** Generate a fallback model from a specific provider */
const fallbackModelFromProvider = (provider: ModelProvider) =>
  fc.record({
    name: modelNameArb,
    version: modelVersionArb,
    capabilities: capabilitiesArb,
    contextWindow: contextWindowArb,
  }).map((fields) => ({
    id: `fallback-${provider}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    provider,
    name: fields.name,
    version: fields.version,
    capabilities: fields.capabilities,
    costPerInputToken: 0.000003,
    costPerOutputToken: 0.000012,
    contextWindow: fields.contextWindow,
    status: 'available' as ModelStatus,
    maxTemperature: 2.0,
    maxOutputTokens: 4096,
  } as AIModel));

describe('Property 16: Model Registry — Fallback Automático', () => {
  let service: ModelRegistryService;
  let modelRepo: Record<string, jest.Mock>;
  let tenantModelRepo: Record<string, jest.Mock>;
  let tokenUsageRepo: Record<string, jest.Mock>;
  let eventEmitter: { emit: jest.Mock };

  const mockQueryBuilder = {
    andWhere: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn(),
    getOne: jest.fn(),
  };

  beforeEach(async () => {
    modelRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
      create: jest.fn((entity: any) => entity),
      save: jest.fn((entity: any) => Promise.resolve(entity)),
    };

    tenantModelRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      create: jest.fn((entity: any) => entity),
      save: jest.fn((entity: any) => Promise.resolve(entity)),
    };

    tokenUsageRepo = {
      create: jest.fn((entity: any) => entity),
      save: jest.fn((entity: any) => Promise.resolve(entity)),
    };

    eventEmitter = {
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModelRegistryService,
        { provide: getRepositoryToken(AIModel), useValue: modelRepo },
        { provide: getRepositoryToken(TenantModel), useValue: tenantModelRepo },
        { provide: getRepositoryToken(TokenUsage), useValue: tokenUsageRepo },
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get<ModelRegistryService>(ModelRegistryService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    mockQueryBuilder.andWhere.mockReturnThis();
    mockQueryBuilder.where.mockReturnThis();
    mockQueryBuilder.orderBy.mockReturnThis();
    mockQueryBuilder.addOrderBy.mockReturnThis();
    mockQueryBuilder.getMany.mockReset();
    mockQueryBuilder.getOne.mockReset();
  });

  it('getFallback returns a different model when primary is unavailable (same-provider fallback)', async () => {
    await fc.assert(
      fc.asyncProperty(
        unavailablePrimaryArb,
        async (primaryModel) => {
          // Generate a fallback from the same provider
          const fallbackModel: AIModel = {
            id: `fallback-same-${Math.random().toString(36).slice(2, 8)}`,
            provider: primaryModel.provider,
            name: `fallback-${primaryModel.name}`,
            version: '2.0',
            capabilities: primaryModel.capabilities,
            costPerInputToken: 0.000003,
            costPerOutputToken: 0.000010,
            contextWindow: primaryModel.contextWindow + 1000,
            status: 'available',
            maxTemperature: 2.0,
            maxOutputTokens: 4096,
          };

          // Setup mocks
          modelRepo.findOne.mockResolvedValue(primaryModel);
          mockQueryBuilder.getOne.mockResolvedValueOnce(fallbackModel);

          // Execute
          const result = await service.getFallback(primaryModel.id);

          // Assertions
          // 1. Fallback MUST be a different model than the primary
          expect(result).not.toBeNull();
          expect(result!.id).not.toBe(primaryModel.id);

          // 2. Fallback MUST be available
          expect(result!.status).toBe('available');

          // 3. Event 'model.fallback.activated' MUST be emitted
          expect(eventEmitter.emit).toHaveBeenCalledWith(
            'model.fallback.activated',
            expect.objectContaining({
              primaryModelId: primaryModel.id,
              primaryModelName: primaryModel.name,
              fallbackModelId: fallbackModel.id,
              fallbackModelName: fallbackModel.name,
            }),
          );
        },
      ),
      { numRuns: 120 },
    );
  });

  it('getFallback routes to cross-provider fallback when same-provider has no available models', async () => {
    await fc.assert(
      fc.asyncProperty(
        unavailablePrimaryArb,
        fc.constantFrom<ModelProvider>(...ALL_PROVIDERS),
        async (primaryModel, fallbackProvider) => {
          // Ensure fallback provider is different from primary
          const actualFallbackProvider =
            fallbackProvider === primaryModel.provider
              ? ALL_PROVIDERS.find((p) => p !== primaryModel.provider) ?? 'openai'
              : fallbackProvider;

          const crossFallback: AIModel = {
            id: `cross-fallback-${Math.random().toString(36).slice(2, 8)}`,
            provider: actualFallbackProvider as ModelProvider,
            name: `cross-${actualFallbackProvider}-model`,
            version: '1.0',
            capabilities: ['text_generation'],
            costPerInputToken: 0.000004,
            costPerOutputToken: 0.000012,
            contextWindow: 128000,
            status: 'available',
            maxTemperature: 2.0,
            maxOutputTokens: 4096,
          };

          // Setup mocks: no same-provider fallback available
          modelRepo.findOne.mockResolvedValue(primaryModel);
          // First call (same provider): null
          mockQueryBuilder.getOne.mockResolvedValueOnce(null);

          // Cross-provider calls: the service iterates CROSS_PROVIDER_FALLBACK_ORDER
          // We need to return null for all providers before the actualFallbackProvider,
          // then return the crossFallback for the matching provider.
          const crossProviderOrder = ['openai', 'anthropic', 'google', 'deepseek', 'meta', 'alibaba'];
          for (const provider of crossProviderOrder) {
            if (provider === primaryModel.provider) continue;
            if (provider === actualFallbackProvider) {
              mockQueryBuilder.getOne.mockResolvedValueOnce(crossFallback);
              break;
            }
            mockQueryBuilder.getOne.mockResolvedValueOnce(null);
          }

          // Execute
          const result = await service.getFallback(primaryModel.id);

          // Assertions
          // 1. Fallback MUST be returned (not null)
          expect(result).not.toBeNull();

          // 2. Fallback MUST be from a different provider than the primary
          // (since same-provider returned null)
          expect(result!.provider).not.toBe(primaryModel.provider);

          // 3. Fallback model MUST be available
          expect(result!.status).toBe('available');

          // 4. Event 'model.fallback.activated' MUST be emitted
          expect(eventEmitter.emit).toHaveBeenCalledWith(
            'model.fallback.activated',
            expect.objectContaining({
              primaryModelId: primaryModel.id,
              fallbackModelId: crossFallback.id,
              reason: expect.stringContaining(primaryModel.name),
            }),
          );
        },
      ),
      { numRuns: 120 },
    );
  });

  it('model.fallback.activated event contains all required observability fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        unavailablePrimaryArb,
        async (primaryModel) => {
          // Clear mocks between iterations to avoid accumulation
          eventEmitter.emit.mockClear();
          modelRepo.findOne.mockReset();
          mockQueryBuilder.getOne.mockReset();
          mockQueryBuilder.where.mockReturnThis();
          mockQueryBuilder.andWhere.mockReturnThis();
          mockQueryBuilder.orderBy.mockReturnThis();
          mockQueryBuilder.addOrderBy.mockReturnThis();

          const fallbackModel: AIModel = {
            id: `obs-fallback-${Math.random().toString(36).slice(2, 8)}`,
            provider: primaryModel.provider,
            name: `obs-fallback-model`,
            version: '1.0',
            capabilities: ['text_generation'],
            costPerInputToken: 0.000002,
            costPerOutputToken: 0.000008,
            contextWindow: 64000,
            status: 'available',
            maxTemperature: 2.0,
            maxOutputTokens: 4096,
          };

          modelRepo.findOne.mockResolvedValue(primaryModel);
          mockQueryBuilder.getOne.mockResolvedValueOnce(fallbackModel);

          await service.getFallback(primaryModel.id);

          // Verify the emitted event has ALL required fields for observability
          expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
          const [eventName, eventPayload] = eventEmitter.emit.mock.calls[0];

          expect(eventName).toBe('model.fallback.activated');
          expect(eventPayload).toHaveProperty('primaryModelId', primaryModel.id);
          expect(eventPayload).toHaveProperty('primaryModelName', primaryModel.name);
          expect(eventPayload).toHaveProperty('fallbackModelId', fallbackModel.id);
          expect(eventPayload).toHaveProperty('fallbackModelName', fallbackModel.name);
          expect(eventPayload).toHaveProperty('reason');
          expect(eventPayload).toHaveProperty('timestamp');
          expect(eventPayload.timestamp).toBeInstanceOf(Date);

          // Reason should reference the primary model's unavailability
          expect(eventPayload.reason).toContain(primaryModel.name);
          expect(eventPayload.reason).toContain(primaryModel.status);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('getFallback returns null and does NOT emit event when no fallback is available anywhere', async () => {
    await fc.assert(
      fc.asyncProperty(
        unavailablePrimaryArb,
        async (primaryModel) => {
          modelRepo.findOne.mockResolvedValue(primaryModel);
          // No fallback available anywhere (all providers return null)
          mockQueryBuilder.getOne.mockResolvedValue(null);

          const result = await service.getFallback(primaryModel.id);

          // When no fallback exists, return null
          expect(result).toBeNull();

          // No event should be emitted since no fallback was activated
          expect(eventEmitter.emit).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});
