import * as fc from 'fast-check';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { GuardrailsService } from '../services/guardrails.service';
import { Guardrail } from '../entities/guardrail.entity';
import { GuardrailRule } from '../interfaces/guardrails-service.interface';

/**
 * Property 21: Guardrails de Sistema São Imutáveis
 *
 * For any attempt to modify, disable, or remove system guardrails
 * (regardless of user role), the operation MUST be rejected.
 * System guardrails are immutable and persist for all tenants.
 *
 * **Validates: Requirements 11.1**
 */

describe('Property 21: Guardrails de Sistema São Imutáveis', () => {
  // System guardrail names matching the service definitions
  const SYSTEM_GUARDRAIL_NAMES = [
    'no-health-promises',
    'no-diagnoses',
    'no-prescriptions',
    'no-anvisa-cfm-violations',
    'no-cross-tenant-data',
  ];

  function createSystemGuardrail(name: string, id: string): Guardrail {
    return {
      id,
      tenantId: null,
      type: 'system',
      name,
      description: `System guardrail: ${name}`,
      rule: {
        pattern: '\\btest\\b',
        categories: ['test_category'],
        action: 'block',
        maxRetries: 3,
      },
      version: 1,
      isActive: true,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    };
  }

  // Generate a pool of system guardrails with fixed UUIDs
  const systemGuardrails = SYSTEM_GUARDRAIL_NAMES.map((name, index) =>
    createSystemGuardrail(name, `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa${String(index).padStart(2, '0')}`),
  );

  function createService() {
    const guardrailRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
    };

    const violationRepo = {
      find: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    const versionRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };

    const eventEmitter = {
      emit: jest.fn(),
    };

    // Mock cache service for distributed cache
    const mockCacheService = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      deleteByPattern: jest.fn().mockResolvedValue(0),
      exists: jest.fn().mockResolvedValue(false),
      getMetrics: jest.fn(),
      getHealth: jest.fn(),
    };

    const mockKeyBuilder = {
      tenantKey: jest.fn((tenantId: string, resource: string, identifier: string) =>
        `beautygrowth:cache:tenant:${tenantId}:${resource}:${identifier}`),
      globalKey: jest.fn((resource: string, identifier: string) =>
        `beautygrowth:cache:global:${resource}:${identifier}`),
      tenantPattern: jest.fn(),
      tenantResourcePattern: jest.fn(),
      validateTenantId: jest.fn(),
    };

    // Configure findOne to return the correct system guardrail when queried by id
    guardrailRepo.findOne.mockImplementation(async (options: any) => {
      if (options?.where?.id) {
        return systemGuardrails.find((g) => g.id === options.where.id) ?? null;
      }
      return null;
    });

    const service = new GuardrailsService(
      guardrailRepo as any,
      violationRepo as any,
      versionRepo as any,
      eventEmitter as any,
      mockCacheService as any,
      mockKeyBuilder as any,
    );

    return { service, guardrailRepo, violationRepo, versionRepo, eventEmitter };
  }

  // Arbitrary for generating random UpdateGuardrailDto fields
  const updateDtoArb = fc.record({
    name: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
    description: fc.option(fc.string({ minLength: 1, maxLength: 500 }), { nil: undefined }),
    pattern: fc.option(fc.string({ minLength: 1, maxLength: 200 }), { nil: undefined }),
    classifier: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
    categories: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 5 }), { nil: undefined }),
    action: fc.option(fc.constantFrom('block' as const, 'regenerate' as const, 'warn' as const), { nil: undefined }),
    maxRetries: fc.option(fc.integer({ min: 1, max: 10 }), { nil: undefined }),
    isActive: fc.option(fc.boolean(), { nil: undefined }),
  });

  // Arbitrary for system guardrail selection
  const systemGuardrailArb = fc.constantFrom(...systemGuardrails);

  // Arbitrary for user roles
  const roleArb = fc.constantFrom('admin', 'operator', 'viewer');

  describe('Update operations on system guardrails are rejected', () => {
    it('should reject ANY update DTO applied to system guardrails', async () => {
      const { service } = createService();

      await fc.assert(
        fc.asyncProperty(
          systemGuardrailArb,
          updateDtoArb,
          async (guardrail, dto) => {
            await expect(
              service.updateTenantGuardrail(guardrail.id, dto),
            ).rejects.toThrow(ForbiddenException);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should reject update attempts regardless of user role', async () => {
      const { service } = createService();

      await fc.assert(
        fc.asyncProperty(
          systemGuardrailArb,
          updateDtoArb,
          roleArb,
          async (guardrail, dto, _role) => {
            // The userId represents any role - system guardrails are immutable for ALL
            const userId = `user-${_role}-${Math.random().toString(36).slice(2)}`;
            await expect(
              service.updateTenantGuardrail(guardrail.id, dto, userId),
            ).rejects.toThrow(ForbiddenException);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Delete operations on system guardrails are rejected', () => {
    it('should reject deletion of any system guardrail', async () => {
      const { service } = createService();

      await fc.assert(
        fc.asyncProperty(
          systemGuardrailArb,
          async (guardrail) => {
            await expect(
              service.deleteTenantGuardrail(guardrail.id),
            ).rejects.toThrow(ForbiddenException);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Rollback operations on system guardrails are rejected', () => {
    it('should reject rollback to any version for system guardrails', async () => {
      const { service } = createService();

      await fc.assert(
        fc.asyncProperty(
          systemGuardrailArb,
          fc.integer({ min: 1, max: 100 }),
          async (guardrail, targetVersion) => {
            await expect(
              service.rollback(guardrail.id, targetVersion),
            ).rejects.toThrow(ForbiddenException);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('All mutation operations rejected for all roles', () => {
    it('should reject update, delete, and rollback for admin/operator/viewer roles', async () => {
      const { service } = createService();

      const operationArb = fc.constantFrom('update', 'delete', 'rollback');

      await fc.assert(
        fc.asyncProperty(
          systemGuardrailArb,
          roleArb,
          operationArb,
          updateDtoArb,
          fc.integer({ min: 1, max: 50 }),
          async (guardrail, _role, operation, dto, rollbackVersion) => {
            switch (operation) {
              case 'update':
                await expect(
                  service.updateTenantGuardrail(guardrail.id, dto, `user-${_role}`),
                ).rejects.toThrow(ForbiddenException);
                break;
              case 'delete':
                await expect(
                  service.deleteTenantGuardrail(guardrail.id),
                ).rejects.toThrow(ForbiddenException);
                break;
              case 'rollback':
                await expect(
                  service.rollback(guardrail.id, rollbackVersion),
                ).rejects.toThrow(ForbiddenException);
                break;
            }
          },
        ),
        { numRuns: 150 },
      );
    });
  });

  describe('System guardrails remain unchanged after rejection attempts', () => {
    it('should preserve system guardrail state after failed mutation attempts', async () => {
      const { service, guardrailRepo } = createService();

      await fc.assert(
        fc.asyncProperty(
          systemGuardrailArb,
          updateDtoArb,
          fc.integer({ min: 1, max: 50 }),
          async (guardrail, dto, rollbackVersion) => {
            // Capture original state
            const originalState = { ...guardrail };

            // Attempt all mutation operations (all should throw)
            try { await service.updateTenantGuardrail(guardrail.id, dto); } catch {}
            try { await service.deleteTenantGuardrail(guardrail.id); } catch {}
            try { await service.rollback(guardrail.id, rollbackVersion); } catch {}

            // Verify the guardrail repo's save/remove was never called for system guardrails
            const saveCalls = guardrailRepo.save.mock.calls;
            const removeCalls = guardrailRepo.remove.mock.calls;

            // Filter calls that involve system guardrails
            for (const call of saveCalls) {
              const saved = call[0];
              if (saved && saved.type === 'system') {
                fail('save() should never be called on a system guardrail');
              }
            }

            for (const call of removeCalls) {
              const removed = call[0];
              if (removed && removed.type === 'system') {
                fail('remove() should never be called on a system guardrail');
              }
            }

            // Verify original guardrail object unchanged
            expect(guardrail.id).toBe(originalState.id);
            expect(guardrail.type).toBe('system');
            expect(guardrail.tenantId).toBeNull();
            expect(guardrail.name).toBe(originalState.name);
            expect(guardrail.description).toBe(originalState.description);
            expect(guardrail.rule).toEqual(originalState.rule);
            expect(guardrail.version).toBe(originalState.version);
            expect(guardrail.isActive).toBe(originalState.isActive);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
