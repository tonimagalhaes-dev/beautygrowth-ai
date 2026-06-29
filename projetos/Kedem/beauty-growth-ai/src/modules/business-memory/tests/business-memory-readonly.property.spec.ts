import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { BusinessMemoryController } from '../business-memory.controller';
import { BusinessMemoryService } from '../services/business-memory.service';
import { MemoryCategory } from '../entities/business-memory-entry.entity';
import { TenantContext } from '@shared/interfaces';

/**
 * Property 9: Memória de Negócio Somente-Leitura para Agentes
 *
 * For any write attempt to Business Memory originating from an AI Agent,
 * the system MUST reject the operation. Only updates originating from
 * Clinic configurations, campaigns, or Primary User actions are allowed.
 *
 * This test:
 * 1. Generates random write operations (any category, key, value) from agent context
 * 2. Verifies ALL are rejected with ForbiddenException
 * 3. Verifies reads from agent context are allowed (getByTenant, getByCategory, getSnapshot)
 *
 * **Validates: Requirements 6.4**
 */

// -- Arbitraries --

/** Random MemoryCategory */
const memoryCategoryArb = fc.constantFrom<MemoryCategory>(
  'brand',
  'audience',
  'campaigns',
  'procedures',
  'preferences',
);

/** Random non-empty key string */
const keyArb = fc.stringOf(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz_0123456789'.split('')),
  { minLength: 1, maxLength: 50 },
);

/** Random value (any JSON-serializable data) */
const valueArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 100 }),
  fc.integer(),
  fc.boolean(),
  fc.dictionary(fc.string({ minLength: 1, maxLength: 10 }), fc.string({ minLength: 1, maxLength: 20 })),
  fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 5 }),
);

/** Random campaign DTO */
const campaignDtoArb = fc.record({
  campaignId: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 50 }),
  type: fc.constantFrom('social_media', 'email', 'sms', 'paid_ads'),
  status: fc.constantFrom<'completed' | 'cancelled'>('completed', 'cancelled'),
  startedAt: fc.date({ min: new Date('2023-01-01'), max: new Date('2025-01-01') }).map(
    (d) => d.toISOString(),
  ),
  completedAt: fc.date({ min: new Date('2023-01-01'), max: new Date('2025-01-01') }).map(
    (d) => d.toISOString(),
  ),
  metrics: fc.option(
    fc.dictionary(
      fc.constantFrom('impressions', 'clicks', 'conversions', 'reach'),
      fc.integer({ min: 0, max: 100000 }),
    ),
    { nil: undefined },
  ),
});

/** Random sync body (brand or clinic data) */
const syncBodyArb = fc.record({
  source: fc.constantFrom<'brand' | 'clinic'>('brand', 'clinic'),
  data: fc.dictionary(
    fc.constantFrom('voiceTone', 'colorPalette', 'name', 'specialties', 'phone', 'email'),
    valueArb,
  ),
});

/** Random tenant context */
const tenantContextArb = fc.record({
  tenantId: fc.uuid(),
  userId: fc.uuid(),
  role: fc.constantFrom<'admin' | 'operator' | 'viewer'>('admin', 'operator', 'viewer'),
});

describe('Property 9: Memória de Negócio Somente-Leitura para Agentes', () => {
  let controller: BusinessMemoryController;
  let service: Record<string, jest.Mock>;

  beforeEach(async () => {
    service = {
      getByTenant: jest.fn().mockResolvedValue([]),
      getByCategory: jest.fn().mockResolvedValue([]),
      getSnapshot: jest.fn().mockResolvedValue({
        tenantId: 'test',
        categories: { brand: [], audience: [], campaigns: [], procedures: [], preferences: [] },
        lastUpdated: null,
      }),
      recordCampaign: jest.fn().mockResolvedValue(undefined),
      syncFromBrand: jest.fn().mockResolvedValue(undefined),
      syncFromClinic: jest.fn().mockResolvedValue(undefined),
      validateNotAgent: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BusinessMemoryController],
      providers: [
        {
          provide: BusinessMemoryService,
          useValue: service,
        },
      ],
    }).compile();

    controller = module.get<BusinessMemoryController>(BusinessMemoryController);
  });

  it('should reject ALL write operations (recordCampaign) from agent callers', async () => {
    await fc.assert(
      fc.asyncProperty(tenantContextArb, campaignDtoArb, async (tenant, dto) => {
        await expect(
          controller.recordCampaign(tenant as TenantContext, dto as any, 'agent'),
        ).rejects.toThrow(ForbiddenException);

        // The service should never be called for agent writes
        expect(service.recordCampaign).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it('should reject ALL write operations (manualSync) from agent callers', async () => {
    await fc.assert(
      fc.asyncProperty(tenantContextArb, syncBodyArb, async (tenant, body) => {
        await expect(
          controller.manualSync(tenant as TenantContext, body as any, 'agent'),
        ).rejects.toThrow(ForbiddenException);

        // Neither sync method should be called for agent writes
        expect(service.syncFromBrand).not.toHaveBeenCalled();
        expect(service.syncFromClinic).not.toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it('should allow read operations (getAll) from agent callers', async () => {
    await fc.assert(
      fc.asyncProperty(tenantContextArb, async (tenant) => {
        // Agent reads should succeed (no ForbiddenException)
        const result = await controller.getAll(tenant as TenantContext);

        expect(result).toBeDefined();
        expect(service.getByTenant).toHaveBeenCalledWith(tenant.tenantId);
      }),
      { numRuns: 100 },
    );
  });

  it('should allow read operations (getByCategory) from agent callers', async () => {
    await fc.assert(
      fc.asyncProperty(tenantContextArb, memoryCategoryArb, async (tenant, category) => {
        // Agent reads by category should succeed
        const result = await controller.getByCategory(tenant as TenantContext, category);

        expect(result).toBeDefined();
        expect(service.getByCategory).toHaveBeenCalledWith(tenant.tenantId, category);
      }),
      { numRuns: 100 },
    );
  });

  it('should allow read operations (getSnapshot) from agent callers', async () => {
    await fc.assert(
      fc.asyncProperty(tenantContextArb, async (tenant) => {
        // Agent snapshot reads should succeed
        const result = await controller.getSnapshot(tenant as TenantContext);

        expect(result).toBeDefined();
        expect(service.getSnapshot).toHaveBeenCalledWith(tenant.tenantId);
      }),
      { numRuns: 100 },
    );
  });

  it('should allow write operations from non-agent callers (user)', async () => {
    await fc.assert(
      fc.asyncProperty(tenantContextArb, campaignDtoArb, async (tenant, dto) => {
        const result = await controller.recordCampaign(tenant as TenantContext, dto as any, 'user');

        expect(result).toEqual({ success: true });
        expect(service.recordCampaign).toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it('should allow write operations when no caller type header is present', async () => {
    await fc.assert(
      fc.asyncProperty(tenantContextArb, campaignDtoArb, async (tenant, dto) => {
        const result = await controller.recordCampaign(tenant as TenantContext, dto as any, undefined);

        expect(result).toEqual({ success: true });
        expect(service.recordCampaign).toHaveBeenCalled();
      }),
      { numRuns: 100 },
    );
  });

  it('should reject agent writes via validateNotAgent service method', async () => {
    await fc.assert(
      fc.asyncProperty(keyArb, valueArb, async (_key, _value) => {
        // Direct service-level validation
        const realService = new (class extends BusinessMemoryService {
          constructor() {
            super(null as any);
          }
        })();

        expect(() => realService.validateNotAgent('agent')).toThrow(ForbiddenException);
        expect(() => realService.validateNotAgent('user')).not.toThrow();
        expect(() => realService.validateNotAgent('system')).not.toThrow();
      }),
      { numRuns: 100 },
    );
  });
});
