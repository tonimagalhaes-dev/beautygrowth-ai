import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { BrandController } from '../brand.controller';
import { BrandService } from '../services/brand.service';
import { BrandIdentity } from '../entities/brand-identity.entity';
/* eslint-disable @typescript-eslint/no-unused-vars */

describe('BrandController', () => {
  let controller: BrandController;
  let brandService: Record<string, jest.Mock>;

  const mockTenantId = '550e8400-e29b-41d4-a716-446655440000';
  const mockBrandId = '660e8400-e29b-41d4-a716-446655440001';

  beforeEach(async () => {
    brandService = {
      create: jest.fn(),
      update: jest.fn(),
      getByTenant: jest.fn(),
      uploadLogo: jest.fn(),
      suggestOptions: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BrandController],
      providers: [
        {
          provide: BrandService,
          useValue: brandService,
        },
      ],
    }).compile();

    controller = module.get<BrandController>(BrandController);
  });

  describe('create', () => {
    it('should create brand identity', async () => {
      const dto = {
        voiceTone: 'Professional',
        colorPalette: [{ hex: '#FF0000', name: 'Red', isPrimary: true }],
        targetAudience: 'Women 25-45',
        differentials: ['High quality'],
        values: ['Excellence'],
      };

      const mockBrand = {
        id: mockBrandId,
        tenantId: mockTenantId,
        ...dto,
        logoUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as BrandIdentity;

      brandService.create!.mockResolvedValue(mockBrand);

      const result = await controller.create(dto, mockTenantId);
      expect(result).toEqual(mockBrand);
      expect(brandService.create).toHaveBeenCalledWith(mockTenantId, dto);
    });

    it('should throw if tenantId is missing', async () => {
      const dto = {
        voiceTone: 'Professional',
        colorPalette: [{ hex: '#FF0000', name: 'Red', isPrimary: true }],
        targetAudience: 'Women 25-45',
        differentials: ['High quality'],
        values: ['Excellence'],
      };

      await expect(controller.create(dto, undefined)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('update', () => {
    it('should update brand identity', async () => {
      const dto = { voiceTone: 'Updated tone' };
      const mockBrand = {
        id: mockBrandId,
        tenantId: mockTenantId,
        voiceTone: 'Updated tone',
      } as BrandIdentity;

      brandService.update!.mockResolvedValue(mockBrand);

      const result = await controller.update(mockBrandId, dto, mockTenantId);
      expect(result.voiceTone).toBe('Updated tone');
    });
  });

  describe('getByTenant', () => {
    it('should return brand for tenant', async () => {
      const mockBrand = { id: mockBrandId, tenantId: mockTenantId } as BrandIdentity;
      brandService.getByTenant!.mockResolvedValue(mockBrand);

      const result = await controller.getByTenant(mockTenantId);
      expect(result).toEqual(mockBrand);
    });
  });

  describe('uploadLogo', () => {
    it('should upload logo file', async () => {
      const mockFile = {
        buffer: Buffer.from('fake'),
        mimetype: 'image/png',
        size: 1024,
        originalname: 'logo.png',
      } as Express.Multer.File;

      const mockResult = {
        url: 'http://localhost/logos/test.png',
        format: 'png' as const,
        sizeBytes: 1024,
        dimensions: { width: 200, height: 200 },
      };

      brandService.uploadLogo!.mockResolvedValue(mockResult);

      const result = await controller.uploadLogo(mockFile);
      expect(result).toEqual(mockResult);
    });

    it('should throw if no file uploaded', async () => {
      await expect(
        controller.uploadLogo(undefined as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('suggestOptions', () => {
    it('should return suggestions', async () => {
      const dto = {
        field: 'voiceTone',
        clinicName: 'Clínica Bella',
        specialties: ['Harmonização'],
      };

      brandService.suggestOptions!.mockResolvedValue([
        'Suggestion 1',
        'Suggestion 2',
        'Suggestion 3',
      ]);

      const result = await controller.suggestOptions(dto);
      expect(result.suggestions).toHaveLength(3);
    });
  });
});
