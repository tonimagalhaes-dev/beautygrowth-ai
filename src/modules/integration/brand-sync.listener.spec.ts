import { Test, TestingModule } from '@nestjs/testing';
import { BrandSyncListener } from './brand-sync.listener';
import { BrandService } from '../brand/services/brand.service';
import { BusinessMemoryService } from '../business-memory/services/business-memory.service';
import { BrandUpdatedPayload } from '../business-memory/interfaces/events.interface';
import { BrandIdentity } from '../brand/entities/brand-identity.entity';

describe('BrandSyncListener', () => {
  let listener: BrandSyncListener;
  let brandService: { getByTenant: jest.Mock };
  let businessMemoryService: { syncFromBrand: jest.Mock };

  const mockBrand: Partial<BrandIdentity> = {
    id: 'brand-123',
    tenantId: 'tenant-abc',
    voiceTone: 'Profissional e acolhedor',
    colorPalette: [{ hex: '#FF0000', name: 'Vermelho', isPrimary: true }],
    logoUrl: 'https://storage.example.com/logos/logo.png',
    targetAudience: 'Mulheres 25-45 anos',
    differentials: ['Tecnologia de ponta', 'Atendimento personalizado'],
    values: ['Excelência', 'Ética'],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    brandService = {
      getByTenant: jest.fn(),
    };

    businessMemoryService = {
      syncFromBrand: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrandSyncListener,
        { provide: BrandService, useValue: brandService },
        { provide: BusinessMemoryService, useValue: businessMemoryService },
      ],
    }).compile();

    listener = module.get<BrandSyncListener>(BrandSyncListener);
  });

  describe('handleBrandUpdated', () => {
    const payload: BrandUpdatedPayload = {
      tenantId: 'tenant-abc',
      brandId: 'brand-123',
      action: 'updated',
      timestamp: new Date(),
    };

    it('should fetch brand data and sync to business memory on brand.updated event', async () => {
      brandService.getByTenant.mockResolvedValue(mockBrand as BrandIdentity);
      businessMemoryService.syncFromBrand.mockResolvedValue(undefined);

      await listener.handleBrandUpdated(payload);

      expect(brandService.getByTenant).toHaveBeenCalledWith('tenant-abc');
      expect(businessMemoryService.syncFromBrand).toHaveBeenCalledWith(
        'tenant-abc',
        {
          voiceTone: mockBrand.voiceTone,
          colorPalette: mockBrand.colorPalette,
          logoUrl: mockBrand.logoUrl,
          targetAudience: mockBrand.targetAudience,
          differentials: mockBrand.differentials,
          values: mockBrand.values,
        },
      );
    });

    it('should handle brand.created events the same as updates', async () => {
      const createPayload: BrandUpdatedPayload = {
        ...payload,
        action: 'created',
      };
      brandService.getByTenant.mockResolvedValue(mockBrand as BrandIdentity);
      businessMemoryService.syncFromBrand.mockResolvedValue(undefined);

      await listener.handleBrandUpdated(createPayload);

      expect(brandService.getByTenant).toHaveBeenCalledWith('tenant-abc');
      expect(businessMemoryService.syncFromBrand).toHaveBeenCalledWith(
        'tenant-abc',
        expect.objectContaining({
          voiceTone: mockBrand.voiceTone,
        }),
      );
    });

    it('should not call syncFromBrand if brand is not found', async () => {
      brandService.getByTenant.mockResolvedValue(null);

      await listener.handleBrandUpdated(payload);

      expect(brandService.getByTenant).toHaveBeenCalledWith('tenant-abc');
      expect(businessMemoryService.syncFromBrand).not.toHaveBeenCalled();
    });

    it('should not throw on syncFromBrand failure (resilience)', async () => {
      brandService.getByTenant.mockResolvedValue(mockBrand as BrandIdentity);
      businessMemoryService.syncFromBrand.mockRejectedValue(
        new Error('Database connection lost'),
      );

      // Should not throw — resilience pattern
      await expect(listener.handleBrandUpdated(payload)).resolves.not.toThrow();
    });

    it('should not throw if brandService fails (resilience)', async () => {
      brandService.getByTenant.mockRejectedValue(
        new Error('Brand service unavailable'),
      );

      await expect(listener.handleBrandUpdated(payload)).resolves.not.toThrow();
    });

    it('should complete sync within 60s SLA for normal operations', async () => {
      brandService.getByTenant.mockResolvedValue(mockBrand as BrandIdentity);
      businessMemoryService.syncFromBrand.mockResolvedValue(undefined);

      const startTime = Date.now();
      await listener.handleBrandUpdated(payload);
      const duration = Date.now() - startTime;

      // In unit tests this will be near-instant, but validates the flow completes
      expect(duration).toBeLessThan(60000);
    });

    it('should pass all brand fields to syncFromBrand', async () => {
      brandService.getByTenant.mockResolvedValue(mockBrand as BrandIdentity);
      businessMemoryService.syncFromBrand.mockResolvedValue(undefined);

      await listener.handleBrandUpdated(payload);

      const syncCall = businessMemoryService.syncFromBrand.mock.calls[0];
      const brandData = syncCall[1];

      expect(brandData).toHaveProperty('voiceTone');
      expect(brandData).toHaveProperty('colorPalette');
      expect(brandData).toHaveProperty('logoUrl');
      expect(brandData).toHaveProperty('targetAudience');
      expect(brandData).toHaveProperty('differentials');
      expect(brandData).toHaveProperty('values');
    });
  });

  describe('event-driven integration', () => {
    it('listener handleBrandUpdated is a callable method', () => {
      expect(listener.handleBrandUpdated).toBeDefined();
      expect(typeof listener.handleBrandUpdated).toBe('function');
    });
  });
});
