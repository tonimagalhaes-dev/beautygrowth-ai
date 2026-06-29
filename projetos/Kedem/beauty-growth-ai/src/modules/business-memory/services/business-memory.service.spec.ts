import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';
import { BusinessMemoryService } from './business-memory.service';
import { BusinessMemoryEntry } from '../entities/business-memory-entry.entity';

describe('BusinessMemoryService', () => {
  let service: BusinessMemoryService;
  let repository: Record<string, jest.Mock>;

  const tenantId = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    repository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BusinessMemoryService,
        {
          provide: getRepositoryToken(BusinessMemoryEntry),
          useValue: repository,
        },
      ],
    }).compile();

    service = module.get<BusinessMemoryService>(BusinessMemoryService);
  });

  describe('getByTenant', () => {
    it('should return all memory entries for the tenant', async () => {
      const entries = [
        { id: '1', tenantId, category: 'brand', key: 'voice_tone', value: 'Professional', version: 1 },
        { id: '2', tenantId, category: 'audience', key: 'target_audience', value: 'Women 25-45', version: 1 },
      ];
      repository.find.mockResolvedValue(entries);

      const result = await service.getByTenant(tenantId);

      expect(result).toEqual(entries);
      expect(repository.find).toHaveBeenCalledWith({
        where: { tenantId },
        order: { category: 'ASC', key: 'ASC' },
      });
    });
  });

  describe('getByCategory', () => {
    it('should return entries for a specific category', async () => {
      const entries = [
        { id: '1', tenantId, category: 'brand', key: 'voice_tone', value: 'Professional', version: 1 },
      ];
      repository.find.mockResolvedValue(entries);

      const result = await service.getByCategory(tenantId, 'brand');

      expect(result).toEqual(entries);
      expect(repository.find).toHaveBeenCalledWith({
        where: { tenantId, category: 'brand' },
        order: { key: 'ASC' },
      });
    });
  });

  describe('syncFromBrand', () => {
    it('should upsert brand data as memory entries', async () => {
      repository.findOne.mockResolvedValue(null);
      repository.create.mockImplementation((data: any) => data);
      repository.save.mockImplementation((data: any) => Promise.resolve(data));

      await service.syncFromBrand(tenantId, {
        voiceTone: 'Professional and warm',
        colorPalette: [{ hex: '#FF0000', name: 'Red', isPrimary: true }],
        targetAudience: 'Women 25-45',
      });

      // Should have created 3 entries: voice_tone, color_palette, target_audience
      expect(repository.save).toHaveBeenCalledTimes(3);
    });

    it('should update existing entries and bump version on sync', async () => {
      const existing = {
        id: '1',
        tenantId,
        category: 'brand',
        key: 'voice_tone',
        value: 'Old tone',
        version: 2,
        updatedBy: 'system',
      };
      repository.findOne.mockResolvedValue(existing);
      repository.save.mockImplementation((data: any) => Promise.resolve(data));

      await service.syncFromBrand(tenantId, {
        voiceTone: 'New professional tone',
      });

      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          value: 'New professional tone',
          version: 3,
          updatedBy: 'system',
        }),
      );
    });

    it('should keep previous version on sync failure (resilience)', async () => {
      repository.findOne.mockRejectedValue(new Error('DB connection failed'));

      // Should NOT throw — error is caught and logged
      await expect(
        service.syncFromBrand(tenantId, { voiceTone: 'test' }),
      ).resolves.not.toThrow();
    });
  });

  describe('syncFromClinic', () => {
    it('should upsert clinic data as memory entries', async () => {
      repository.findOne.mockResolvedValue(null);
      repository.create.mockImplementation((data: any) => data);
      repository.save.mockImplementation((data: any) => Promise.resolve(data));

      await service.syncFromClinic(tenantId, {
        name: 'Beauty Clinic',
        specialties: ['dermatology', 'aesthetics'],
        targetAudience: 'Women 25-45',
        phone: '11999999999',
        email: 'clinic@example.com',
        website: 'https://clinic.com',
      });

      // Should have created 6 entries
      expect(repository.save).toHaveBeenCalledTimes(6);
    });

    it('should keep previous version on sync failure (resilience)', async () => {
      repository.findOne.mockRejectedValue(new Error('DB connection failed'));

      await expect(
        service.syncFromClinic(tenantId, { name: 'test' }),
      ).resolves.not.toThrow();
    });
  });

  describe('recordCampaign', () => {
    it('should record a campaign entry', async () => {
      repository.findOne.mockResolvedValue(null);
      repository.create.mockImplementation((data: any) => data);
      repository.save.mockImplementation((data: any) => Promise.resolve(data));

      const campaign = {
        campaignId: 'campaign-1',
        name: 'Summer Campaign',
        type: 'social_media',
        status: 'completed' as const,
        startedAt: new Date('2024-01-01'),
        completedAt: new Date('2024-01-31'),
        metrics: { impressions: 10000, clicks: 500 },
      };

      await service.recordCampaign(tenantId, campaign);

      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          category: 'campaigns',
          key: 'campaign_campaign-1',
          value: campaign,
          updatedBy: 'system',
        }),
      );
    });
  });

  describe('getSnapshot', () => {
    it('should return categorized snapshot with last update timestamp', async () => {
      const now = new Date();
      const entries = [
        { id: '1', tenantId, category: 'brand', key: 'voice_tone', value: 'Professional', version: 1, updatedAt: now, updatedBy: 'system' },
        { id: '2', tenantId, category: 'audience', key: 'target', value: 'Women 25-45', version: 2, updatedAt: new Date(now.getTime() - 1000), updatedBy: 'system' },
        { id: '3', tenantId, category: 'campaigns', key: 'campaign_1', value: { name: 'Summer' }, version: 1, updatedAt: new Date(now.getTime() - 2000), updatedBy: 'system' },
      ];
      repository.find.mockResolvedValue(entries);

      const snapshot = await service.getSnapshot(tenantId);

      expect(snapshot.tenantId).toBe(tenantId);
      expect(snapshot.categories.brand).toHaveLength(1);
      expect(snapshot.categories.audience).toHaveLength(1);
      expect(snapshot.categories.campaigns).toHaveLength(1);
      expect(snapshot.categories.procedures).toHaveLength(0);
      expect(snapshot.categories.preferences).toHaveLength(0);
      expect(snapshot.lastUpdated).toEqual(now);
    });

    it('should return null lastUpdated when no entries exist', async () => {
      repository.find.mockResolvedValue([]);

      const snapshot = await service.getSnapshot(tenantId);

      expect(snapshot.lastUpdated).toBeNull();
      expect(snapshot.categories.brand).toHaveLength(0);
    });
  });

  describe('validateNotAgent', () => {
    it('should throw ForbiddenException for agent callers', () => {
      expect(() => service.validateNotAgent('agent')).toThrow(ForbiddenException);
    });

    it('should not throw for non-agent callers', () => {
      expect(() => service.validateNotAgent('user')).not.toThrow();
      expect(() => service.validateNotAgent('system')).not.toThrow();
    });
  });

  describe('Event Handlers', () => {
    describe('handleClinicCreated', () => {
      it('should sync clinic data to memory', async () => {
        repository.findOne.mockResolvedValue(null);
        repository.create.mockImplementation((data: any) => data);
        repository.save.mockImplementation((data: any) => Promise.resolve(data));

        await service.handleClinicCreated({
          clinic: {
            tenantId,
            name: 'Test Clinic',
            phone: '11999999999',
            email: 'test@clinic.com',
            specialties: ['aesthetics'],
            targetAudience: 'Women',
          },
        });

        expect(repository.save).toHaveBeenCalled();
      });
    });

    describe('handleClinicUpdated', () => {
      it('should sync updated clinic data to memory', async () => {
        repository.findOne.mockResolvedValue(null);
        repository.create.mockImplementation((data: any) => data);
        repository.save.mockImplementation((data: any) => Promise.resolve(data));

        await service.handleClinicUpdated({
          clinic: {
            tenantId,
            name: 'Updated Clinic',
            phone: '11999999999',
            email: 'test@clinic.com',
            specialties: ['aesthetics', 'dermatology'],
            targetAudience: 'Women 25-45',
          },
          updatedFields: ['name', 'specialties'],
        });

        expect(repository.save).toHaveBeenCalled();
      });
    });

    describe('handleCampaignCompleted', () => {
      it('should record campaign in memory', async () => {
        repository.findOne.mockResolvedValue(null);
        repository.create.mockImplementation((data: any) => data);
        repository.save.mockImplementation((data: any) => Promise.resolve(data));

        await service.handleCampaignCompleted({
          tenantId,
          campaignId: 'camp-1',
          name: 'Black Friday',
          type: 'email',
          status: 'completed',
          startedAt: new Date('2024-11-20'),
          completedAt: new Date('2024-11-30'),
          metrics: { emails_sent: 1000 },
        });

        expect(repository.save).toHaveBeenCalledWith(
          expect.objectContaining({
            tenantId,
            category: 'campaigns',
            key: 'campaign_camp-1',
          }),
        );
      });
    });
  });
});
