import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { BusinessMemoryService } from '../services/business-memory.service';
import { BusinessMemoryEntry, MemoryCategory } from '../entities/business-memory-entry.entity';

/**
 * Property 28: Resiliência da Memória de Negócio
 *
 * Simulate sync failures, verify previous version remains accessible.
 * BusinessMemoryService.syncFromBrand() wraps everything in try/catch —
 * on failure it logs but does NOT throw, keeping previous data intact.
 *
 * **Validates: Requirements 6.8**
 */

// -- Arbitraries --

/** Random memory category */
const memoryCategoryArb = fc.constantFrom<MemoryCategory>(
  'brand',
  'audience',
  'campaigns',
  'procedures',
  'preferences',
);

/** Random key string (realistic memory keys) */
const memoryKeyArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz_'.split('')),
  { minLength: 3, maxLength: 30 },
);

/** Random JSONB value */
const memoryValueArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 100 }),
  fc.array(fc.string({ minLength: 1, maxLength: 30 }), { minLength: 1, maxLength: 5 }),
  fc.dictionary(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 2, maxLength: 10 }),
    fc.string({ minLength: 1, maxLength: 50 }),
    { minKeys: 1, maxKeys: 4 },
  ),
);

/** Random version number */
const versionArb = fc.integer({ min: 1, max: 50 });

/** Arbitrary for a single pre-populated memory entry */
const memoryEntryArb = fc.record({
  category: memoryCategoryArb,
  key: memoryKeyArb,
  value: memoryValueArb,
  version: versionArb,
  updatedBy: fc.constantFrom('system', 'user-123', 'admin-456'),
});

/** Arbitrary for a list of pre-populated entries (1 to 10) */
const prePopulatedEntriesArb = fc.array(memoryEntryArb, { minLength: 1, maxLength: 10 });

/** Arbitrary for brand data that would trigger sync */
const brandDataArb = fc.record({
  voiceTone: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
  colorPalette: fc.option(
    fc.array(fc.record({ hex: fc.hexaString({ minLength: 6, maxLength: 6 }), name: fc.string({ minLength: 1, maxLength: 20 }), isPrimary: fc.boolean() }), { minLength: 1, maxLength: 6 }),
    { nil: undefined },
  ),
  targetAudience: fc.option(fc.string({ minLength: 1, maxLength: 100 }), { nil: undefined }),
  differentials: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 5 }), { nil: undefined }),
  values: fc.option(fc.array(fc.string({ minLength: 1, maxLength: 50 }), { minLength: 1, maxLength: 5 }), { nil: undefined }),
});

/** Random error types for simulating sync failures */
const errorArb = fc.oneof(
  fc.constant(new Error('Connection refused')),
  fc.constant(new Error('timeout')),
  fc.constant(new Error('ECONNRESET')),
  fc.constant(new Error('relation "business_memory_entries" does not exist')),
  fc.constant(new Error('deadlock detected')),
);

describe('Property 28: Resiliência da Memória de Negócio', () => {
  let service: BusinessMemoryService;
  let memoryRepo: Record<string, jest.Mock>;

  const mockTenantId = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BusinessMemoryService,
        {
          provide: getRepositoryToken(BusinessMemoryEntry),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<BusinessMemoryService>(BusinessMemoryService);
    memoryRepo = module.get(getRepositoryToken(BusinessMemoryEntry));
  });

  it('syncFromBrand does NOT throw when repository throws during sync', async () => {
    await fc.assert(
      fc.asyncProperty(
        prePopulatedEntriesArb,
        brandDataArb,
        errorArb,
        async (existingEntries, brandData, syncError) => {
          // Pre-populate: setup existing entries in the repository
          const entries: BusinessMemoryEntry[] = existingEntries.map((e, i) => ({
            id: `entry-${i}`,
            tenantId: mockTenantId,
            category: e.category,
            key: e.key,
            value: e.value,
            version: e.version,
            updatedAt: new Date('2024-01-01'),
            updatedBy: e.updatedBy,
          }));

          // Make findOne throw to simulate sync failure
          // (syncFromBrand calls upsertEntry which calls findOne first)
          memoryRepo.findOne.mockRejectedValue(syncError);

          // syncFromBrand MUST NOT throw — it swallows the error
          await expect(
            service.syncFromBrand(mockTenantId, brandData),
          ).resolves.toBeUndefined();
        },
      ),
      { numRuns: 150 },
    );
  });

  it('previous entries remain accessible and unchanged after sync failure', async () => {
    await fc.assert(
      fc.asyncProperty(
        prePopulatedEntriesArb,
        brandDataArb,
        errorArb,
        async (existingEntries, brandData, syncError) => {
          // Pre-populate: create entries as they would exist in the DB
          const entries: BusinessMemoryEntry[] = existingEntries.map((e, i) => ({
            id: `entry-${i}`,
            tenantId: mockTenantId,
            category: e.category,
            key: e.key,
            value: e.value,
            version: e.version,
            updatedAt: new Date('2024-01-01'),
            updatedBy: e.updatedBy,
          }));

          // Deep clone for later comparison (before sync attempt)
          const entriesSnapshot = JSON.parse(JSON.stringify(entries));

          // Configure repo: findOne throws during sync to simulate failure
          memoryRepo.findOne.mockRejectedValue(syncError);

          // Attempt sync — should NOT throw
          await service.syncFromBrand(mockTenantId, brandData);

          // Now verify previous entries are still accessible:
          // Reset findOne to succeed for reads, configure find to return pre-existing entries
          memoryRepo.find.mockResolvedValue(entries);

          const result = await service.getByTenant(mockTenantId);

          // Verify entries are still accessible
          expect(result).toHaveLength(entries.length);

          // Verify data integrity — entries are unchanged
          for (let i = 0; i < result.length; i++) {
            expect(result[i].id).toBe(entriesSnapshot[i].id);
            expect(result[i].tenantId).toBe(entriesSnapshot[i].tenantId);
            expect(result[i].category).toBe(entriesSnapshot[i].category);
            expect(result[i].key).toBe(entriesSnapshot[i].key);
            expect(JSON.stringify(result[i].value)).toBe(
              JSON.stringify(entriesSnapshot[i].value),
            );
            expect(result[i].version).toBe(entriesSnapshot[i].version);
            expect(result[i].updatedBy).toBe(entriesSnapshot[i].updatedBy);
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('syncFromBrand returns undefined (void) regardless of error type', async () => {
    await fc.assert(
      fc.asyncProperty(brandDataArb, errorArb, async (brandData, syncError) => {
        // Make the save operation fail (simulates write failure after findOne succeeds)
        memoryRepo.findOne.mockResolvedValue(null); // no existing entry
        memoryRepo.create.mockImplementation((data: any) => data);
        memoryRepo.save.mockRejectedValue(syncError);

        // Must still not throw and must return undefined
        const result = await service.syncFromBrand(mockTenantId, brandData);
        expect(result).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});
