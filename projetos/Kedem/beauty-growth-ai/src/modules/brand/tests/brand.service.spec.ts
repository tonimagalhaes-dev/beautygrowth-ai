import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { BrandService } from '../services/brand.service';
import { BrandIdentity } from '../entities/brand-identity.entity';
import { STORAGE_SERVICE } from '../interfaces/brand.interface';
import { CreateBrandDto } from '../dto/create-brand.dto';
import { UpdateBrandDto } from '../dto/update-brand.dto';

describe('BrandService', () => {
  let service: BrandService;
  let repository: jest.Mocked<Repository<BrandIdentity>>;
  let storageService: { upload: jest.Mock; delete: jest.Mock; getUrl: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  const mockTenantId = '550e8400-e29b-41d4-a716-446655440000';
  const mockBrandId = '660e8400-e29b-41d4-a716-446655440001';

  const validCreateDto: CreateBrandDto = {
    voiceTone: 'Profissional e acolhedor',
    colorPalette: [
      { hex: '#FF5733', name: 'Coral', isPrimary: true },
      { hex: '#33FF57', name: 'Menta', isPrimary: false },
    ],
    targetAudience: 'Mulheres 25-45 anos, classe A/B',
    differentials: ['Atendimento personalizado', 'Tecnologia de ponta'],
    values: ['Excelência', 'Segurança'],
  };

  beforeEach(async () => {
    storageService = {
      upload: jest.fn().mockResolvedValue('http://localhost:9000/bucket/logos/test.png'),
      delete: jest.fn().mockResolvedValue(undefined),
      getUrl: jest.fn().mockReturnValue('http://localhost:9000/bucket/logos/test.png'),
    };

    eventEmitter = {
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrandService,
        {
          provide: getRepositoryToken(BrandIdentity),
          useValue: {
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
        {
          provide: STORAGE_SERVICE,
          useValue: storageService,
        },
        {
          provide: EventEmitter2,
          useValue: eventEmitter,
        },
      ],
    }).compile();

    service = module.get<BrandService>(BrandService);
    repository = module.get(getRepositoryToken(BrandIdentity));
  });

  describe('create', () => {
    it('should create brand identity successfully', async () => {
      const savedBrand = {
        id: mockBrandId,
        tenantId: mockTenantId,
        ...validCreateDto,
        logoUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as BrandIdentity;

      repository.findOne.mockResolvedValue(null);
      repository.create.mockReturnValue(savedBrand);
      repository.save.mockResolvedValue(savedBrand);

      const result = await service.create(mockTenantId, validCreateDto);

      expect(result).toEqual(savedBrand);
      expect(repository.create).toHaveBeenCalled();
      expect(repository.save).toHaveBeenCalled();
      expect(eventEmitter.emit).toHaveBeenCalledWith('brand.updated', {
        tenantId: mockTenantId,
        brandId: mockBrandId,
        action: 'created',
        timestamp: expect.any(Date),
      });
    });

    it('should reject if brand already exists for tenant', async () => {
      repository.findOne.mockResolvedValue({ id: mockBrandId } as BrandIdentity);

      await expect(service.create(mockTenantId, validCreateDto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject if no primary color in palette', async () => {
      const dto: CreateBrandDto = {
        ...validCreateDto,
        colorPalette: [
          { hex: '#FF5733', name: 'Coral', isPrimary: false },
        ],
      };

      repository.findOne.mockResolvedValue(null);

      await expect(service.create(mockTenantId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject if differential exceeds 200 chars', async () => {
      const dto: CreateBrandDto = {
        ...validCreateDto,
        differentials: ['a'.repeat(201)],
      };

      repository.findOne.mockResolvedValue(null);

      await expect(service.create(mockTenantId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject if value exceeds 200 chars', async () => {
      const dto: CreateBrandDto = {
        ...validCreateDto,
        values: ['a'.repeat(201)],
      };

      repository.findOne.mockResolvedValue(null);

      await expect(service.create(mockTenantId, dto)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('update', () => {
    it('should update brand identity successfully', async () => {
      const existingBrand = {
        id: mockBrandId,
        tenantId: mockTenantId,
        voiceTone: 'Old tone',
        colorPalette: [{ hex: '#000000', name: 'Black', isPrimary: true }],
        targetAudience: 'Old audience',
        differentials: ['Old diff'],
        values: ['Old value'],
        logoUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as BrandIdentity;

      const updateDto: UpdateBrandDto = {
        voiceTone: 'New professional tone',
      };

      repository.findOne.mockResolvedValue(existingBrand);
      repository.save.mockResolvedValue({
        ...existingBrand,
        voiceTone: 'New professional tone',
      });

      const result = await service.update(mockBrandId, mockTenantId, updateDto);

      expect(result.voiceTone).toBe('New professional tone');
      expect(eventEmitter.emit).toHaveBeenCalledWith('brand.updated', {
        tenantId: mockTenantId,
        brandId: mockBrandId,
        action: 'updated',
        timestamp: expect.any(Date),
      });
    });

    it('should throw NotFoundException if brand not found', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.update(mockBrandId, mockTenantId, { voiceTone: 'test' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should validate color palette on update', async () => {
      const existingBrand = {
        id: mockBrandId,
        tenantId: mockTenantId,
        voiceTone: 'Tone',
        colorPalette: [{ hex: '#000000', name: 'Black', isPrimary: true }],
        targetAudience: 'Audience',
        differentials: ['Diff'],
        values: ['Value'],
        logoUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as BrandIdentity;

      repository.findOne.mockResolvedValue(existingBrand);

      await expect(
        service.update(mockBrandId, mockTenantId, {
          colorPalette: [{ hex: '#FF0000', name: 'Red', isPrimary: false }],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getByTenant', () => {
    it('should return brand for tenant', async () => {
      const brand = { id: mockBrandId, tenantId: mockTenantId } as BrandIdentity;
      repository.findOne.mockResolvedValue(brand);

      const result = await service.getByTenant(mockTenantId);
      expect(result).toEqual(brand);
    });

    it('should return null if no brand exists', async () => {
      repository.findOne.mockResolvedValue(null);

      const result = await service.getByTenant(mockTenantId);
      expect(result).toBeNull();
    });
  });

  describe('uploadLogo', () => {
    it('should upload valid PNG logo', async () => {
      const mockFile = {
        buffer: Buffer.from('fake image data'),
        mimetype: 'image/png',
        size: 1024 * 1024, // 1MB
        originalname: 'logo.png',
      } as Express.Multer.File;

      const mockDimensions = jest.fn().mockResolvedValue({ width: 300, height: 300 });

      const result = await service.uploadLogo(mockFile, mockDimensions);

      expect(result.format).toBe('png');
      expect(result.sizeBytes).toBe(1024 * 1024);
      expect(result.dimensions).toEqual({ width: 300, height: 300 });
      expect(result.url).toContain('http://');
      expect(storageService.upload).toHaveBeenCalled();
    });

    it('should reject unsupported format', async () => {
      const mockFile = {
        buffer: Buffer.from('fake data'),
        mimetype: 'image/gif',
        size: 1024,
        originalname: 'logo.gif',
      } as Express.Multer.File;

      await expect(service.uploadLogo(mockFile)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject file larger than 5MB', async () => {
      const mockFile = {
        buffer: Buffer.from('fake data'),
        mimetype: 'image/png',
        size: 6 * 1024 * 1024, // 6MB
        originalname: 'logo.png',
      } as Express.Multer.File;

      await expect(service.uploadLogo(mockFile)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject image with dimensions below 200x200', async () => {
      const mockFile = {
        buffer: Buffer.from('fake data'),
        mimetype: 'image/png',
        size: 1024,
        originalname: 'logo.png',
      } as Express.Multer.File;

      const mockDimensions = jest.fn().mockResolvedValue({ width: 100, height: 100 });

      await expect(service.uploadLogo(mockFile, mockDimensions)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should accept SVG without dimension check', async () => {
      const mockFile = {
        buffer: Buffer.from('<svg></svg>'),
        mimetype: 'image/svg+xml',
        size: 1024,
        originalname: 'logo.svg',
      } as Express.Multer.File;

      const result = await service.uploadLogo(mockFile);

      expect(result.format).toBe('svg');
      expect(storageService.upload).toHaveBeenCalled();
    });
  });

  describe('suggestOptions', () => {
    it('should return suggestions for voiceTone', async () => {
      const context = {
        clinicName: 'Clínica Bella',
        specialties: ['Harmonização Facial'],
      };

      const result = await service.suggestOptions('voiceTone', context);

      expect(result).toHaveLength(3);
      expect(result[0]).toContain('Clínica Bella');
    });

    it('should return suggestions for targetAudience', async () => {
      const context = {
        clinicName: 'Clínica Bella',
        specialties: ['Harmonização Facial'],
      };

      const result = await service.suggestOptions('targetAudience', context);

      expect(result.length).toBeGreaterThanOrEqual(3);
    });

    it('should return fallback suggestions for unknown fields', async () => {
      const context = {
        clinicName: 'Clínica Bella',
        specialties: ['Harmonização Facial'],
      };

      const result = await service.suggestOptions('unknownField', context);

      expect(result.length).toBeGreaterThanOrEqual(3);
    });
  });
});
