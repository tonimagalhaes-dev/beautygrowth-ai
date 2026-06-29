import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { BusinessMemoryController } from '../business-memory.controller';
import { BusinessMemoryService } from '../services/business-memory.service';
import { TenantContext } from '@shared/interfaces';

describe('BusinessMemoryController', () => {
  let controller: BusinessMemoryController;
  let service: Record<string, jest.Mock>;

  const tenantContext: TenantContext = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    role: 'admin',
  };

  beforeEach(async () => {
    service = {
      getByTenant: jest.fn(),
      getByCategory: jest.fn(),
      getSnapshot: jest.fn(),
      recordCampaign: jest.fn(),
      syncFromBrand: jest.fn(),
      syncFromClinic: jest.fn(),
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

  describe('getAll', () => {
    it('should return all memory entries for the tenant', async () => {
      const entries = [{ id: '1', category: 'brand', key: 'voice_tone' }];
      service.getByTenant.mockResolvedValue(entries);

      const result = await controller.getAll(tenantContext);

      expect(result).toEqual(entries);
      expect(service.getByTenant).toHaveBeenCalledWith(tenantContext.tenantId);
    });
  });

  describe('getByCategory', () => {
    it('should return entries for a valid category', async () => {
      const entries = [{ id: '1', category: 'brand', key: 'voice_tone' }];
      service.getByCategory.mockResolvedValue(entries);

      const result = await controller.getByCategory(tenantContext, 'brand');

      expect(result).toEqual(entries);
      expect(service.getByCategory).toHaveBeenCalledWith(tenantContext.tenantId, 'brand');
    });

    it('should throw for an invalid category', async () => {
      await expect(
        controller.getByCategory(tenantContext, 'invalid' as any),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('getSnapshot', () => {
    it('should return the snapshot', async () => {
      const snapshot = {
        tenantId: tenantContext.tenantId,
        categories: { brand: [], audience: [], campaigns: [], procedures: [], preferences: [] },
        lastUpdated: new Date(),
      };
      service.getSnapshot.mockResolvedValue(snapshot);

      const result = await controller.getSnapshot(tenantContext);

      expect(result).toEqual(snapshot);
      expect(service.getSnapshot).toHaveBeenCalledWith(tenantContext.tenantId);
    });
  });

  describe('recordCampaign', () => {
    const dto = {
      campaignId: 'camp-1',
      name: 'Summer Campaign',
      type: 'social_media',
      status: 'completed' as const,
      startedAt: '2024-01-01T00:00:00Z',
      completedAt: '2024-01-31T00:00:00Z',
      metrics: { impressions: 10000 },
    };

    it('should record a campaign for non-agent callers', async () => {
      service.recordCampaign.mockResolvedValue(undefined);

      const result = await controller.recordCampaign(tenantContext, dto, 'user');

      expect(result).toEqual({ success: true });
      expect(service.recordCampaign).toHaveBeenCalled();
    });

    it('should reject campaign recording from agent callers', async () => {
      await expect(
        controller.recordCampaign(tenantContext, dto, 'agent'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow when no caller type header present', async () => {
      service.recordCampaign.mockResolvedValue(undefined);

      const result = await controller.recordCampaign(tenantContext, dto, undefined);

      expect(result).toEqual({ success: true });
    });
  });

  describe('manualSync', () => {
    it('should sync brand data for non-agent callers', async () => {
      service.syncFromBrand.mockResolvedValue(undefined);

      const result = await controller.manualSync(
        tenantContext,
        { source: 'brand', data: { voiceTone: 'Professional' } },
        'user',
      );

      expect(result).toEqual({ success: true });
      expect(service.syncFromBrand).toHaveBeenCalledWith(
        tenantContext.tenantId,
        { voiceTone: 'Professional' },
      );
    });

    it('should sync clinic data for non-agent callers', async () => {
      service.syncFromClinic.mockResolvedValue(undefined);

      const result = await controller.manualSync(
        tenantContext,
        { source: 'clinic', data: { name: 'My Clinic' } },
        'user',
      );

      expect(result).toEqual({ success: true });
      expect(service.syncFromClinic).toHaveBeenCalledWith(
        tenantContext.tenantId,
        { name: 'My Clinic' },
      );
    });

    it('should reject sync from agent callers', async () => {
      await expect(
        controller.manualSync(
          tenantContext,
          { source: 'brand', data: {} },
          'agent',
        ),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
