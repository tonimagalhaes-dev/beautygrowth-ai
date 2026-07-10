import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { GuardrailsService } from './guardrails.service';
import { Guardrail } from '../entities/guardrail.entity';
import { GuardrailViolation } from '../entities/guardrail-violation.entity';
import { GuardrailVersion } from '../entities/guardrail-version.entity';
import { GuardrailRule } from '../interfaces/guardrails-service.interface';
import { ICacheService } from '../../cache/interfaces/cache-service.interface';
import { CacheKeyBuilder } from '../../cache/services/cache-key-builder.service';
import { CACHE_SERVICE } from '../../cache/config/cache.constants';

describe('GuardrailsService', () => {
  let service: GuardrailsService;
  let guardrailRepo: Record<string, jest.Mock>;
  let violationRepo: Record<string, jest.Mock>;
  let versionRepo: Record<string, jest.Mock>;
  let eventEmitter: { emit: jest.Mock };
  let cache: Record<string, jest.Mock>;
  let keyBuilder: CacheKeyBuilder;

  const mockTenantId = '11111111-1111-4111-a111-111111111111';
  const mockAgentId = '22222222-2222-4222-a222-222222222222';
  const mockGuardrailId = '33333333-3333-4333-a333-333333333333';

  const createMockGuardrail = (
    overrides: Partial<Guardrail> = {},
  ): Guardrail => ({
    id: mockGuardrailId,
    tenantId: mockTenantId,
    type: 'tenant',
    name: 'test-guardrail',
    description: 'Test guardrail description',
    rule: {
      pattern: '\\bproibido\\b',
      categories: ['test'],
      action: 'block',
      maxRetries: 3,
    },
    version: 1,
    isActive: true,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  });

  const createSystemGuardrail = (
    overrides: Partial<Guardrail> = {},
  ): Guardrail =>
    createMockGuardrail({
      tenantId: null,
      type: 'system',
      name: 'no-diagnoses',
      description: 'Proíbe diagnósticos médicos',
      rule: {
        pattern: '\\b(diagnóstic[a-z]*|você tem)\\b',
        categories: ['diagnosis'],
        action: 'block',
        maxRetries: 3,
      },
      ...overrides,
    });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GuardrailsService,
        {
          provide: getRepositoryToken(Guardrail),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            remove: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(GuardrailViolation),
          useValue: {
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            createQueryBuilder: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(GuardrailVersion),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
        {
          provide: CACHE_SERVICE,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            delete: jest.fn().mockResolvedValue(undefined),
            deleteByPattern: jest.fn().mockResolvedValue(0),
            exists: jest.fn().mockResolvedValue(false),
            getMetrics: jest.fn().mockReturnValue({}),
            getHealth: jest.fn().mockReturnValue({}),
          },
        },
        {
          provide: CacheKeyBuilder,
          useValue: new CacheKeyBuilder(),
        },
      ],
    }).compile();

    service = module.get<GuardrailsService>(GuardrailsService);
    guardrailRepo = module.get(getRepositoryToken(Guardrail));
    violationRepo = module.get(getRepositoryToken(GuardrailViolation));
    versionRepo = module.get(getRepositoryToken(GuardrailVersion));
    eventEmitter = module.get(EventEmitter2);
    cache = module.get(CACHE_SERVICE);
    keyBuilder = module.get(CacheKeyBuilder);
  });

  describe('validate', () => {
    it('should return valid when content has no violations', async () => {
      const systemGuardrail = createSystemGuardrail();
      // cache miss for tenant key and system key
      cache.get.mockResolvedValue(null);
      guardrailRepo.find
        .mockResolvedValueOnce([systemGuardrail]) // system from DB
        .mockResolvedValueOnce([]); // tenant from DB

      const result = await service.validate(
        'Conteúdo perfeitamente seguro sobre procedimentos estéticos',
        mockTenantId,
      );

      expect(result.isValid).toBe(true);
      expect(result.violations).toHaveLength(0);
      expect(result.checkedGuardrails).toBe(1);
    });

    it('should detect violation when content matches a guardrail pattern', async () => {
      const systemGuardrail = createSystemGuardrail();
      cache.get.mockResolvedValue(null);
      guardrailRepo.find
        .mockResolvedValueOnce([systemGuardrail]) // system
        .mockResolvedValueOnce([]); // tenant

      violationRepo.create.mockImplementation((data) => data);
      violationRepo.save.mockResolvedValue([]);

      const result = await service.validate(
        'Baseado na análise, você tem uma condição dermatológica',
        mockTenantId,
      );

      expect(result.isValid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].guardrailName).toBe('no-diagnoses');
      expect(result.violations[0].severity).toBe('critical');
    });

    it('should check both system and tenant guardrails', async () => {
      const systemGuardrail = createSystemGuardrail();
      const tenantGuardrail = createMockGuardrail({
        rule: {
          pattern: '\\bconcorrente\\b',
          categories: ['competitor_mention'],
          action: 'warn',
          maxRetries: 3,
        },
      });

      cache.get.mockResolvedValue(null);
      guardrailRepo.find
        .mockResolvedValueOnce([systemGuardrail]) // system
        .mockResolvedValueOnce([tenantGuardrail]); // tenant

      violationRepo.create.mockImplementation((data) => data);
      violationRepo.save.mockResolvedValue([]);

      const result = await service.validate(
        'A concorrente oferece melhores preços',
        mockTenantId,
      );

      expect(result.isValid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].guardrailName).toBe('test-guardrail');
      expect(result.checkedGuardrails).toBe(2);
    });

    it('should detect multiple violations from different guardrails', async () => {
      const systemGuardrail = createSystemGuardrail();
      const tenantGuardrail = createMockGuardrail({
        id: '44444444-4444-4444-a444-444444444444',
        name: 'no-competitor',
        rule: {
          pattern: '\\bconcorrente\\b',
          categories: ['competitor_mention'],
          action: 'warn',
          maxRetries: 3,
        },
      });

      cache.get.mockResolvedValue(null);
      guardrailRepo.find
        .mockResolvedValueOnce([systemGuardrail]) // system
        .mockResolvedValueOnce([tenantGuardrail]); // tenant

      violationRepo.create.mockImplementation((data) => data);
      violationRepo.save.mockResolvedValue([]);

      const result = await service.validate(
        'A concorrente diagnosticou incorretamente',
        mockTenantId,
      );

      expect(result.isValid).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(1);
    });

    it('should log violations with full context', async () => {
      const tenantGuardrail = createMockGuardrail();
      cache.get.mockResolvedValue(null);
      guardrailRepo.find
        .mockResolvedValueOnce([]) // system
        .mockResolvedValueOnce([tenantGuardrail]); // tenant

      violationRepo.create.mockImplementation((data) => data);
      violationRepo.save.mockResolvedValue([]);

      await service.validate(
        'Conteúdo proibido aqui',
        mockTenantId,
        mockAgentId,
      );

      expect(violationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: mockTenantId,
          guardrailId: mockGuardrailId,
          guardrailName: 'test-guardrail',
          agentId: mockAgentId,
          originalContent: 'Conteúdo proibido aqui',
          severity: 'critical',
          actionTaken: 'warned',
        }),
      );
      expect(violationRepo.save).toHaveBeenCalled();
    });
  });

  describe('validateWithRegeneration', () => {
    it('should return success when content is valid', async () => {
      cache.get.mockResolvedValue(null);
      guardrailRepo.find
        .mockResolvedValueOnce([]) // system
        .mockResolvedValueOnce([]); // tenant

      const result = await service.validateWithRegeneration(
        'Safe content',
        mockTenantId,
        mockAgentId,
        1,
      );

      expect(result.success).toBe(true);
      expect(result.blocked).toBe(false);
      expect(result.violations).toHaveLength(0);
    });

    it('should signal regeneration on first violation (attempt < max)', async () => {
      const guardrail = createMockGuardrail({
        rule: {
          pattern: '\\bproibido\\b',
          categories: ['test'],
          action: 'regenerate',
          maxRetries: 3,
        },
      });

      cache.get.mockResolvedValue(null);
      guardrailRepo.find
        .mockResolvedValueOnce([]) // system
        .mockResolvedValueOnce([guardrail]); // tenant
      guardrailRepo.findOne.mockResolvedValue(guardrail);
      violationRepo.create.mockImplementation((data) => data);
      violationRepo.save.mockResolvedValue([]);

      const result = await service.validateWithRegeneration(
        'Conteúdo proibido',
        mockTenantId,
        mockAgentId,
        1,
      );

      expect(result.success).toBe(false);
      expect(result.blocked).toBe(false);
      expect(result.attempt).toBe(1);
      expect(result.violations).toHaveLength(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'guardrails.violation',
        expect.objectContaining({
          tenantId: mockTenantId,
          agentId: mockAgentId,
          action: 'regenerate',
        }),
      );
    });

    it('should block after max retries (3 consecutive failures)', async () => {
      const guardrail = createMockGuardrail({
        rule: {
          pattern: '\\bproibido\\b',
          categories: ['test'],
          action: 'regenerate',
          maxRetries: 3,
        },
      });

      cache.get.mockResolvedValue(null);
      guardrailRepo.find
        .mockResolvedValueOnce([]) // system
        .mockResolvedValueOnce([guardrail]); // tenant
      guardrailRepo.findOne.mockResolvedValue(guardrail);
      violationRepo.create.mockImplementation((data) => data);
      violationRepo.save.mockResolvedValue([]);

      const result = await service.validateWithRegeneration(
        'Conteúdo proibido',
        mockTenantId,
        mockAgentId,
        3, // max retries reached
      );

      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.attempt).toBe(3);
    });
  });

  describe('getSystemGuardrails', () => {
    it('should return all system guardrails', async () => {
      const systemGuardrails = [
        createSystemGuardrail({ name: 'no-diagnoses' }),
        createSystemGuardrail({ name: 'no-prescriptions' }),
      ];
      guardrailRepo.find.mockResolvedValue(systemGuardrails);

      const result = await service.getSystemGuardrails();

      expect(guardrailRepo.find).toHaveBeenCalledWith({
        where: { type: 'system' },
        order: { name: 'ASC' },
      });
      expect(result).toHaveLength(2);
    });
  });

  describe('getTenantGuardrails', () => {
    it('should return all guardrails for a specific tenant', async () => {
      const tenantGuardrails = [createMockGuardrail()];
      guardrailRepo.find.mockResolvedValue(tenantGuardrails);

      const result = await service.getTenantGuardrails(mockTenantId);

      expect(guardrailRepo.find).toHaveBeenCalledWith({
        where: { tenantId: mockTenantId, type: 'tenant' },
        order: { createdAt: 'DESC' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('createTenantGuardrail', () => {
    it('should create a new tenant guardrail with correct fields', async () => {
      const dto = {
        name: 'no-competitor-mention',
        description: 'Não mencionar concorrentes',
        pattern: '\\bconcorrente\\b',
        categories: ['competitor'],
        action: 'warn' as const,
      };

      const expectedGuardrail = createMockGuardrail({
        name: dto.name,
        description: dto.description,
        rule: {
          pattern: dto.pattern,
          categories: dto.categories,
          action: 'warn',
          maxRetries: 3,
        },
      });

      guardrailRepo.create.mockReturnValue(expectedGuardrail);
      guardrailRepo.save.mockResolvedValue(expectedGuardrail);
      versionRepo.create.mockImplementation((data) => data);
      versionRepo.save.mockResolvedValue({});

      const result = await service.createTenantGuardrail(mockTenantId, dto);

      expect(guardrailRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: mockTenantId,
          type: 'tenant',
          name: dto.name,
          version: 1,
          isActive: true,
        }),
      );
      expect(result.name).toBe(dto.name);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'guardrails.created',
        expect.objectContaining({ tenantId: mockTenantId }),
      );
    });

    it('should default maxRetries to 3 when not provided', async () => {
      const dto = {
        name: 'test',
        description: 'test description',
        pattern: '\\btest\\b',
        categories: ['test'],
        action: 'regenerate' as const,
      };

      guardrailRepo.create.mockImplementation((data) => data);
      guardrailRepo.save.mockImplementation((data) => ({
        ...data,
        id: mockGuardrailId,
      }));
      versionRepo.create.mockImplementation((data) => data);
      versionRepo.save.mockResolvedValue({});

      await service.createTenantGuardrail(mockTenantId, dto);

      expect(guardrailRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          rule: expect.objectContaining({ maxRetries: 3 }),
        }),
      );
    });

    it('should save initial version for rollback support', async () => {
      const dto = {
        name: 'versioned-guardrail',
        description: 'Test',
        categories: ['test'],
        action: 'block' as const,
      };

      const savedGuardrail = createMockGuardrail({ name: dto.name });
      guardrailRepo.create.mockReturnValue(savedGuardrail);
      guardrailRepo.save.mockResolvedValue(savedGuardrail);
      versionRepo.create.mockImplementation((data) => data);
      versionRepo.save.mockResolvedValue({});

      await service.createTenantGuardrail(mockTenantId, dto);

      expect(versionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          guardrailId: mockGuardrailId,
          version: 1,
          name: savedGuardrail.name,
        }),
      );
      expect(versionRepo.save).toHaveBeenCalled();
    });
  });

  describe('updateTenantGuardrail', () => {
    it('should update a tenant guardrail and increment version', async () => {
      const existing = createMockGuardrail();
      guardrailRepo.findOne.mockResolvedValue(existing);
      versionRepo.create.mockImplementation((data) => data);
      versionRepo.save.mockResolvedValue({});
      guardrailRepo.save.mockImplementation((data) => data);

      const dto = { name: 'updated-name', description: 'Updated desc' };
      const result = await service.updateTenantGuardrail(mockGuardrailId, dto);

      expect(result.name).toBe('updated-name');
      expect(result.description).toBe('Updated desc');
      expect(result.version).toBe(2);
    });

    it('should reject updating a system guardrail', async () => {
      const systemGuardrail = createSystemGuardrail();
      guardrailRepo.findOne.mockResolvedValue(systemGuardrail);

      await expect(
        service.updateTenantGuardrail(mockGuardrailId, { name: 'hack' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should save previous version before updating', async () => {
      const existing = createMockGuardrail();
      guardrailRepo.findOne.mockResolvedValue(existing);
      versionRepo.create.mockImplementation((data) => data);
      versionRepo.save.mockResolvedValue({});
      guardrailRepo.save.mockImplementation((data) => data);

      await service.updateTenantGuardrail(mockGuardrailId, {
        name: 'new-name',
      });

      expect(versionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          guardrailId: mockGuardrailId,
          version: 1,
          name: 'test-guardrail',
        }),
      );
    });

    it('should throw NotFoundException for non-existent guardrail', async () => {
      guardrailRepo.findOne.mockResolvedValue(null);

      await expect(
        service.updateTenantGuardrail('nonexistent', { name: 'test' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should emit guardrails.updated event', async () => {
      const existing = createMockGuardrail();
      guardrailRepo.findOne.mockResolvedValue(existing);
      versionRepo.create.mockImplementation((data) => data);
      versionRepo.save.mockResolvedValue({});
      guardrailRepo.save.mockImplementation((data) => data);

      await service.updateTenantGuardrail(mockGuardrailId, { name: 'new' });

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'guardrails.updated',
        expect.objectContaining({
          tenantId: mockTenantId,
          guardrailId: mockGuardrailId,
        }),
      );
    });
  });

  describe('rollback', () => {
    it('should rollback to a specific version', async () => {
      const existing = createMockGuardrail({ version: 3, name: 'current' });
      const targetVersion = {
        id: 'version-id',
        guardrailId: mockGuardrailId,
        version: 1,
        name: 'original-name',
        description: 'Original description',
        rule: {
          pattern: '\\boriginal\\b',
          categories: ['original'],
          action: 'warn' as const,
          maxRetries: 3,
        },
        isActive: true,
        changedBy: null,
        createdAt: new Date('2024-01-01'),
      };

      guardrailRepo.findOne.mockResolvedValue(existing);
      versionRepo.findOne.mockResolvedValue(targetVersion);
      versionRepo.create.mockImplementation((data) => data);
      versionRepo.save.mockResolvedValue({});
      guardrailRepo.save.mockImplementation((data) => data);

      const result = await service.rollback(mockGuardrailId, 1);

      expect(result.name).toBe('original-name');
      expect(result.description).toBe('Original description');
      expect(result.version).toBe(4);
    });

    it('should reject rollback of system guardrails', async () => {
      const systemGuardrail = createSystemGuardrail();
      guardrailRepo.findOne.mockResolvedValue(systemGuardrail);

      await expect(service.rollback(mockGuardrailId, 1)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw NotFoundException for non-existent version', async () => {
      const existing = createMockGuardrail();
      guardrailRepo.findOne.mockResolvedValue(existing);
      versionRepo.findOne.mockResolvedValue(null);

      await expect(service.rollback(mockGuardrailId, 99)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should save current state before rollback', async () => {
      const existing = createMockGuardrail({ version: 2, name: 'v2-name' });
      const targetVersion = {
        id: 'version-id',
        guardrailId: mockGuardrailId,
        version: 1,
        name: 'v1-name',
        description: 'v1 desc',
        rule: existing.rule,
        isActive: true,
        changedBy: null,
        createdAt: new Date(),
      };

      guardrailRepo.findOne.mockResolvedValue(existing);
      versionRepo.findOne.mockResolvedValue(targetVersion);
      versionRepo.create.mockImplementation((data) => data);
      versionRepo.save.mockResolvedValue({});
      guardrailRepo.save.mockImplementation((data) => data);

      await service.rollback(mockGuardrailId, 1);

      expect(versionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          version: 2,
          name: 'v2-name',
        }),
      );
    });
  });

  describe('deleteTenantGuardrail', () => {
    it('should delete a tenant guardrail', async () => {
      const guardrail = createMockGuardrail();
      guardrailRepo.findOne.mockResolvedValue(guardrail);
      guardrailRepo.remove.mockResolvedValue(guardrail);

      await service.deleteTenantGuardrail(mockGuardrailId);

      expect(guardrailRepo.remove).toHaveBeenCalledWith(guardrail);
    });

    it('should reject deletion of system guardrails', async () => {
      const systemGuardrail = createSystemGuardrail();
      guardrailRepo.findOne.mockResolvedValue(systemGuardrail);

      await expect(
        service.deleteTenantGuardrail(mockGuardrailId),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException for non-existent guardrail', async () => {
      guardrailRepo.findOne.mockResolvedValue(null);

      await expect(
        service.deleteTenantGuardrail('nonexistent'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getViolationReport', () => {
    it('should aggregate violations by guardrail, agent, and daily trends', async () => {
      const violations = [
        {
          id: 'v1',
          tenantId: mockTenantId,
          guardrailId: 'g1',
          guardrailName: 'no-diagnoses',
          agentId: 'a1',
          originalContent: 'test',
          matchedContent: 'match',
          severity: 'critical',
          actionTaken: 'blocked',
          attempt: 1,
          createdAt: new Date('2024-03-01T10:00:00Z'),
        },
        {
          id: 'v2',
          tenantId: mockTenantId,
          guardrailId: 'g1',
          guardrailName: 'no-diagnoses',
          agentId: 'a1',
          originalContent: 'test2',
          matchedContent: 'match2',
          severity: 'critical',
          actionTaken: 'blocked',
          attempt: 1,
          createdAt: new Date('2024-03-01T14:00:00Z'),
        },
        {
          id: 'v3',
          tenantId: mockTenantId,
          guardrailId: 'g2',
          guardrailName: 'no-prescriptions',
          agentId: 'a2',
          originalContent: 'test3',
          matchedContent: 'match3',
          severity: 'high',
          actionTaken: 'regenerated',
          attempt: 1,
          createdAt: new Date('2024-03-02T10:00:00Z'),
        },
      ];

      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(violations),
      };
      violationRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getViolationReport(mockTenantId, {
        start: new Date('2024-03-01'),
        end: new Date('2024-03-31'),
      });

      expect(result.totalViolations).toBe(3);
      expect(result.byGuardrail).toHaveLength(2);
      expect(result.byGuardrail[0].guardrailName).toBe('no-diagnoses');
      expect(result.byGuardrail[0].count).toBe(2);
      expect(result.byAgent).toHaveLength(2);
      expect(result.trends).toHaveLength(2);
    });

    it('should return empty report when no violations exist', async () => {
      const qb = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      };
      violationRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.getViolationReport(mockTenantId, {
        start: new Date('2024-03-01'),
        end: new Date('2024-03-31'),
      });

      expect(result.totalViolations).toBe(0);
      expect(result.byGuardrail).toHaveLength(0);
      expect(result.byAgent).toHaveLength(0);
      expect(result.trends).toHaveLength(0);
    });
  });

  describe('seedSystemGuardrails', () => {
    it('should create system guardrails that do not exist', async () => {
      guardrailRepo.findOne.mockResolvedValue(null);
      guardrailRepo.create.mockImplementation((data) => data);
      guardrailRepo.save.mockImplementation((data) => data);

      await service.seedSystemGuardrails();

      expect(guardrailRepo.create).toHaveBeenCalledTimes(5);
      expect(guardrailRepo.save).toHaveBeenCalledTimes(5);
    });

    it('should not create system guardrails that already exist', async () => {
      guardrailRepo.findOne.mockResolvedValue(createSystemGuardrail());

      await service.seedSystemGuardrails();

      expect(guardrailRepo.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // DISTRIBUTED CACHE TESTS (Requirements 3.1, 3.2, 3.4, 8.6)
  // =========================================================================

  describe('GuardrailsService - Distributed Cache', () => {
    describe('validate() with cache-aside', () => {
      it('returns cached guardrails on cache hit without DB query', async () => {
        const cachedGuardrails = [
          createSystemGuardrail(),
          createMockGuardrail(),
        ];

        // Simulate cache hit for tenant key
        const tenantCacheKey = keyBuilder.tenantKey(
          mockTenantId,
          'guardrails',
          'active',
        );
        cache.get.mockImplementation(async (key: string) => {
          if (key === tenantCacheKey) return cachedGuardrails;
          return null;
        });

        const result = await service.validate(
          'Conteúdo perfeitamente seguro',
          mockTenantId,
        );

        expect(result.isValid).toBe(true);
        expect(result.checkedGuardrails).toBe(2);
        // DB should NOT be queried on cache hit
        expect(guardrailRepo.find).not.toHaveBeenCalled();
      });
    });
  });
});

