import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ModelRegistryService } from './model-registry.service';
import { AIModel } from '../entities/ai-model.entity';
import { TenantModel } from '../entities/tenant-model.entity';
import { TokenUsage } from '../entities/token-usage.entity';

// Helper to create mock models
function createMockModel(overrides: Partial<AIModel> = {}): AIModel {
  return {
    id: 'model-uuid-1',
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
    ...overrides,
  };
}

describe('ModelRegistryService', () => {
  let service: ModelRegistryService;
  let modelRepo: any;
  let tenantModelRepo: any;
  let tokenUsageRepo: any;
  let eventEmitter: any;

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
  });

  describe('list', () => {
    it('should list all models without filters', async () => {
      const models = [createMockModel()];
      mockQueryBuilder.getMany.mockResolvedValue(models);

      const result = await service.list();

      expect(result).toEqual(models);
      expect(modelRepo.createQueryBuilder).toHaveBeenCalledWith('model');
    });

    it('should filter by provider', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      await service.list({ provider: 'anthropic' });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'model.provider = :provider',
        { provider: 'anthropic' },
      );
    });

    it('should filter by status', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      await service.list({ status: 'deprecated' });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'model.status = :status',
        { status: 'deprecated' },
      );
    });

    it('should filter by capability', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      await service.list({ capability: 'vision' });

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        ':capability = ANY(model.capabilities)',
        { capability: 'vision' },
      );
    });
  });

  describe('getById', () => {
    it('should return a model when found', async () => {
      const model = createMockModel();
      modelRepo.findOne.mockResolvedValue(model);

      const result = await service.getById('model-uuid-1');

      expect(result).toEqual(model);
    });

    it('should throw NotFoundException when model not found', async () => {
      modelRepo.findOne.mockResolvedValue(null);

      await expect(service.getById('non-existent')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getAvailableForTenant', () => {
    it('should return models enabled for tenant', async () => {
      const tenantModels = [
        { id: 'tm-1', tenantId: 'tenant-1', modelId: 'model-1', isEnabled: true, enabledAt: new Date(), disabledAt: null },
      ];
      tenantModelRepo.find.mockResolvedValue(tenantModels);

      const models = [createMockModel({ id: 'model-1' })];
      mockQueryBuilder.getMany.mockResolvedValue(models);

      const result = await service.getAvailableForTenant('tenant-1');

      expect(result).toEqual(models);
      expect(tenantModelRepo.find).toHaveBeenCalledWith({
        where: { tenantId: 'tenant-1', isEnabled: true },
      });
    });

    it('should return empty array when no models enabled', async () => {
      tenantModelRepo.find.mockResolvedValue([]);

      const result = await service.getAvailableForTenant('tenant-1');

      expect(result).toEqual([]);
    });
  });

  describe('enableForTenant', () => {
    it('should create a new tenant-model entry', async () => {
      modelRepo.findOne.mockResolvedValue(createMockModel());
      tenantModelRepo.findOne.mockResolvedValue(null);

      await service.enableForTenant('tenant-1', 'model-uuid-1');

      expect(tenantModelRepo.create).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        modelId: 'model-uuid-1',
        isEnabled: true,
      });
      expect(tenantModelRepo.save).toHaveBeenCalled();
    });

    it('should re-enable a previously disabled model', async () => {
      modelRepo.findOne.mockResolvedValue(createMockModel());
      const existing = {
        id: 'tm-1',
        tenantId: 'tenant-1',
        modelId: 'model-uuid-1',
        isEnabled: false,
        enabledAt: new Date(),
        disabledAt: new Date(),
      };
      tenantModelRepo.findOne.mockResolvedValue(existing);

      await service.enableForTenant('tenant-1', 'model-uuid-1');

      expect(tenantModelRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isEnabled: true, disabledAt: null }),
      );
    });

    it('should throw if model does not exist', async () => {
      modelRepo.findOne.mockResolvedValue(null);

      await expect(
        service.enableForTenant('tenant-1', 'non-existent'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('disableForTenant', () => {
    it('should disable an enabled model', async () => {
      const existing = {
        id: 'tm-1',
        tenantId: 'tenant-1',
        modelId: 'model-uuid-1',
        isEnabled: true,
        enabledAt: new Date(),
        disabledAt: null,
      };
      tenantModelRepo.findOne.mockResolvedValue(existing);

      await service.disableForTenant('tenant-1', 'model-uuid-1');

      expect(tenantModelRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ isEnabled: false }),
      );
    });

    it('should throw if model is not enabled for tenant', async () => {
      tenantModelRepo.findOne.mockResolvedValue(null);

      await expect(
        service.disableForTenant('tenant-1', 'model-uuid-1'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('checkAvailability', () => {
    it('should return healthy status for available model', async () => {
      modelRepo.findOne.mockResolvedValue(createMockModel({ status: 'available' }));

      const result = await service.checkAvailability('model-uuid-1');

      expect(result.isAvailable).toBe(true);
      expect(result.modelId).toBe('model-uuid-1');
      expect(result.latencyMs).toBeDefined();
      expect(result.errorMessage).toBeUndefined();
    });

    it('should return unhealthy status for deprecated model', async () => {
      modelRepo.findOne.mockResolvedValue(createMockModel({ status: 'deprecated' }));

      const result = await service.checkAvailability('model-uuid-1');

      expect(result.isAvailable).toBe(false);
      expect(result.errorMessage).toContain('deprecated');
    });

    it('should return unhealthy status for non-existent model', async () => {
      modelRepo.findOne.mockResolvedValue(null);

      const result = await service.checkAvailability('non-existent');

      expect(result.isAvailable).toBe(false);
      expect(result.errorMessage).toContain('not found');
    });
  });

  describe('getFallback', () => {
    it('should return same-provider fallback first', async () => {
      const primary = createMockModel({ id: 'primary', status: 'deprecated' });
      const fallback = createMockModel({ id: 'fallback', name: 'GPT-4o-mini' });

      modelRepo.findOne.mockResolvedValue(primary);
      mockQueryBuilder.getOne.mockResolvedValueOnce(fallback);

      const result = await service.getFallback('primary');

      expect(result).toEqual(fallback);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'model.fallback.activated',
        expect.objectContaining({
          primaryModelId: 'primary',
          fallbackModelId: 'fallback',
        }),
      );
    });

    it('should return cross-provider fallback when same-provider unavailable', async () => {
      const primary = createMockModel({
        id: 'primary',
        provider: 'alibaba',
        status: 'deprecated',
      });
      const crossFallback = createMockModel({
        id: 'cross-fallback',
        provider: 'openai',
      });

      modelRepo.findOne.mockResolvedValue(primary);
      // Same provider (alibaba): no result
      mockQueryBuilder.getOne.mockResolvedValueOnce(null);
      // Cross-provider first in priority order is openai
      mockQueryBuilder.getOne.mockResolvedValueOnce(crossFallback);

      const result = await service.getFallback('primary');

      expect(result).toEqual(crossFallback);
    });

    it('should return null when no fallback available', async () => {
      const primary = createMockModel({ id: 'primary', status: 'deprecated' });

      modelRepo.findOne.mockResolvedValue(primary);
      mockQueryBuilder.getOne.mockResolvedValue(null);

      const result = await service.getFallback('primary');

      expect(result).toBeNull();
    });

    it('should return null when primary model not found', async () => {
      modelRepo.findOne.mockResolvedValue(null);

      const result = await service.getFallback('non-existent');

      expect(result).toBeNull();
    });
  });

  describe('trackUsage', () => {
    it('should create a token usage record', async () => {
      await service.trackUsage('tenant-1', 'model-1', {
        inputTokens: 500,
        outputTokens: 200,
        agentId: 'agent-1',
      });

      expect(tokenUsageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          modelId: 'model-1',
          agentId: 'agent-1',
          inputTokens: 500,
          outputTokens: 200,
        }),
      );
      expect(tokenUsageRepo.save).toHaveBeenCalled();
    });

    it('should use custom timestamp when provided', async () => {
      const customTimestamp = new Date('2024-01-01T00:00:00Z');

      await service.trackUsage('tenant-1', 'model-1', {
        inputTokens: 100,
        outputTokens: 50,
        agentId: 'agent-1',
        timestamp: customTimestamp,
      });

      expect(tokenUsageRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          recordedAt: customTimestamp,
        }),
      );
    });
  });

  describe('notifyDeprecation', () => {
    it('should emit deprecation events for affected tenants', async () => {
      const model = createMockModel({ id: 'model-1', status: 'deprecated' });
      modelRepo.findOne.mockResolvedValue(model);

      const affectedTenants = [
        { id: 'tm-1', tenantId: 'tenant-1', modelId: 'model-1', isEnabled: true, enabledAt: new Date(), disabledAt: null },
        { id: 'tm-2', tenantId: 'tenant-2', modelId: 'model-1', isEnabled: true, enabledAt: new Date(), disabledAt: null },
      ];
      tenantModelRepo.find.mockResolvedValue(affectedTenants);

      await service.notifyDeprecation('model-1');

      expect(eventEmitter.emit).toHaveBeenCalledTimes(2);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'model.deprecated',
        expect.objectContaining({
          modelId: 'model-1',
          tenantId: 'tenant-1',
        }),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'model.deprecated',
        expect.objectContaining({
          modelId: 'model-1',
          tenantId: 'tenant-2',
        }),
      );
    });

    it('should not emit events if model is not deprecated', async () => {
      const model = createMockModel({ id: 'model-1', status: 'available' });
      modelRepo.findOne.mockResolvedValue(model);

      await service.notifyDeprecation('model-1');

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
