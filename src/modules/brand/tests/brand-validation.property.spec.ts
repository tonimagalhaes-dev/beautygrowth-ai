import * as fc from 'fast-check';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreateBrandDto } from '../dto/create-brand.dto';
import { ColorEntryDto } from '../dto/color-entry.dto';
import { BrandService } from '../services/brand.service';
import { BrandIdentity } from '../entities/brand-identity.entity';
import { STORAGE_SERVICE } from '../interfaces/brand.interface';

/**
 * Property 3: Validação de Identidade da Marca
 *
 * For any brand identity input, if voice tone exceeds 500 chars, OR color palette
 * doesn't have at least 1 primary color or exceeds 6 colors, OR target_audience
 * exceeds 300 chars, OR differentials exceed 5 items or any item exceeds 200 chars,
 * the validation MUST reject. For logos, formats outside {PNG, JPG, SVG} OR size > 5MB
 * OR dimensions < 200x200px MUST be rejected.
 *
 * **Validates: Requirements 2.4, 2.6, 2.7**
 */

// --- Arbitraries ---

const validHexColor = fc
  .hexaString({ minLength: 6, maxLength: 6 })
  .map((h) => `#${h}`);

const validColorName = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0);

const validColorEntry = (isPrimary: boolean) =>
  fc.record({
    hex: validHexColor,
    name: validColorName,
    isPrimary: fc.constant(isPrimary),
  });

// A valid color palette: 1-6 colors, at least 1 primary
const validColorPalette = fc
  .tuple(
    validColorEntry(true), // guarantee at least 1 primary
    fc.array(validColorEntry(false), { minLength: 0, maxLength: 4 }),
  )
  .map(([primary, rest]) => [primary, ...rest]);

const validVoiceTone = fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0);

const validTargetAudience = fc.string({ minLength: 1, maxLength: 300 }).filter((s) => s.trim().length > 0);

const validDifferentialItem = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);

const validDifferentials = fc.array(validDifferentialItem, { minLength: 1, maxLength: 5 });

const validValueItem = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);

const validValues = fc.array(validValueItem, { minLength: 1, maxLength: 5 });

// Generates a fully valid CreateBrandDto
const validBrandDtoArb = fc.record({
  voiceTone: validVoiceTone,
  colorPalette: validColorPalette,
  targetAudience: validTargetAudience,
  differentials: validDifferentials,
  values: validValues,
});

// --- DTO Validation Helper ---

async function validateBrandDto(data: any): Promise<{ isValid: boolean; errors: string[] }> {
  const dto = plainToInstance(CreateBrandDto, data);
  const errors = await validate(dto);
  return {
    isValid: errors.length === 0,
    errors: errors.map((e) => `${e.property}: ${Object.values(e.constraints || {}).join(', ')}`),
  };
}

// --- Service Setup Helper ---

function createMockService() {
  return Test.createTestingModule({
    providers: [
      BrandService,
      {
        provide: getRepositoryToken(BrandIdentity),
        useValue: {
          findOne: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockImplementation((data) => ({ id: 'test-id', ...data })),
          save: jest.fn().mockImplementation((data) => Promise.resolve({ ...data, id: 'test-id' })),
        },
      },
      {
        provide: STORAGE_SERVICE,
        useValue: {
          upload: jest.fn().mockResolvedValue('http://localhost:9000/logos/test.png'),
          delete: jest.fn(),
          getUrl: jest.fn(),
        },
      },
      {
        provide: EventEmitter2,
        useValue: { emit: jest.fn() },
      },
    ],
  }).compile();
}

describe('Property 3: Validação de Identidade da Marca', () => {
  let service: BrandService;
  let module: TestingModule;
  const tenantId = '550e8400-e29b-41d4-a716-446655440000';

  beforeAll(async () => {
    module = await createMockService();
    service = module.get<BrandService>(BrandService);
  });

  afterAll(async () => {
    await module.close();
  });

  // ===== DTO VALIDATION TESTS =====

  describe('DTO class-validator: voiceTone constraints', () => {
    it('should reject voiceTone exceeding 500 characters', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 501, maxLength: 600 }),
          validColorPalette,
          validTargetAudience,
          validDifferentials,
          validValues,
          async (voiceTone, colorPalette, targetAudience, differentials, values) => {
            const result = await validateBrandDto({
              voiceTone,
              colorPalette,
              targetAudience,
              differentials,
              values,
            });
            expect(result.isValid).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should accept voiceTone within 500 characters', async () => {
      await fc.assert(
        fc.asyncProperty(
          validVoiceTone,
          validColorPalette,
          validTargetAudience,
          validDifferentials,
          validValues,
          async (voiceTone, colorPalette, targetAudience, differentials, values) => {
            const result = await validateBrandDto({
              voiceTone,
              colorPalette,
              targetAudience,
              differentials,
              values,
            });
            expect(result.isValid).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('DTO class-validator: colorPalette constraints', () => {
    it('should reject colorPalette exceeding 6 colors', async () => {
      await fc.assert(
        fc.asyncProperty(
          validVoiceTone,
          fc.array(validColorEntry(false), { minLength: 7, maxLength: 10 }),
          validTargetAudience,
          validDifferentials,
          validValues,
          async (voiceTone, colorPalette, targetAudience, differentials, values) => {
            const result = await validateBrandDto({
              voiceTone,
              colorPalette,
              targetAudience,
              differentials,
              values,
            });
            expect(result.isValid).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should reject empty colorPalette', async () => {
      await fc.assert(
        fc.asyncProperty(
          validVoiceTone,
          validTargetAudience,
          validDifferentials,
          validValues,
          async (voiceTone, targetAudience, differentials, values) => {
            const result = await validateBrandDto({
              voiceTone,
              colorPalette: [],
              targetAudience,
              differentials,
              values,
            });
            expect(result.isValid).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('DTO class-validator: targetAudience constraints', () => {
    it('should reject targetAudience exceeding 300 characters', async () => {
      await fc.assert(
        fc.asyncProperty(
          validVoiceTone,
          validColorPalette,
          fc.string({ minLength: 301, maxLength: 400 }),
          validDifferentials,
          validValues,
          async (voiceTone, colorPalette, targetAudience, differentials, values) => {
            const result = await validateBrandDto({
              voiceTone,
              colorPalette,
              targetAudience,
              differentials,
              values,
            });
            expect(result.isValid).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('DTO class-validator: differentials constraints', () => {
    it('should reject differentials exceeding 5 items', async () => {
      await fc.assert(
        fc.asyncProperty(
          validVoiceTone,
          validColorPalette,
          validTargetAudience,
          fc.array(validDifferentialItem, { minLength: 6, maxLength: 10 }),
          validValues,
          async (voiceTone, colorPalette, targetAudience, differentials, values) => {
            const result = await validateBrandDto({
              voiceTone,
              colorPalette,
              targetAudience,
              differentials,
              values,
            });
            expect(result.isValid).toBe(false);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ===== SERVICE VALIDATION TESTS =====

  describe('BrandService: color palette primary requirement', () => {
    it('should reject color palette without any primary color', async () => {
      await fc.assert(
        fc.asyncProperty(
          validVoiceTone,
          fc.array(validColorEntry(false), { minLength: 1, maxLength: 6 }),
          validTargetAudience,
          validDifferentials,
          validValues,
          async (voiceTone, colorPalette, targetAudience, differentials, values) => {
            // Ensure none are primary
            const noPrimaryPalette = colorPalette.map((c) => ({ ...c, isPrimary: false }));
            const dto: CreateBrandDto = {
              voiceTone,
              colorPalette: noPrimaryPalette as any,
              targetAudience,
              differentials,
              values,
            };

            await expect(service.create(tenantId, dto)).rejects.toThrow(BadRequestException);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should accept color palette with at least 1 primary color', async () => {
      await fc.assert(
        fc.asyncProperty(
          validBrandDtoArb,
          async (brandData) => {
            // validBrandDtoArb always has at least 1 primary color
            const dto = brandData as unknown as CreateBrandDto;
            const result = await service.create(tenantId, dto);
            expect(result).toBeDefined();
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('BrandService: differentials item length validation', () => {
    it('should reject any differential item exceeding 200 characters', async () => {
      await fc.assert(
        fc.asyncProperty(
          validVoiceTone,
          validColorPalette,
          validTargetAudience,
          fc.tuple(
            fc.array(validDifferentialItem, { minLength: 0, maxLength: 3 }),
            fc.string({ minLength: 201, maxLength: 300 }),
          ),
          validValues,
          async (voiceTone, colorPalette, targetAudience, [validItems, longItem], values) => {
            const differentials = [...validItems, longItem];
            const dto: CreateBrandDto = {
              voiceTone,
              colorPalette: colorPalette as any,
              targetAudience,
              differentials,
              values,
            };

            await expect(service.create(tenantId, dto)).rejects.toThrow(BadRequestException);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ===== LOGO UPLOAD VALIDATION TESTS =====

  describe('BrandService: logo upload validation', () => {
    it('should reject logo formats outside {PNG, JPG, SVG}', async () => {
      const invalidMimeTypes = [
        'image/gif',
        'image/bmp',
        'image/webp',
        'image/tiff',
        'application/pdf',
        'text/plain',
      ];

      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...invalidMimeTypes),
          fc.integer({ min: 1, max: 5 * 1024 * 1024 }),
          async (mimetype, size) => {
            const file = {
              buffer: Buffer.from('fake image data'),
              mimetype,
              size,
              originalname: `logo.${mimetype.split('/')[1]}`,
            } as Express.Multer.File;

            await expect(service.uploadLogo(file)).rejects.toThrow(BadRequestException);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should reject logo size exceeding 5MB', async () => {
      const validMimeTypes = ['image/png', 'image/jpeg', 'image/svg+xml'];

      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...validMimeTypes),
          fc.integer({ min: 5 * 1024 * 1024 + 1, max: 20 * 1024 * 1024 }),
          async (mimetype, size) => {
            const file = {
              buffer: Buffer.from('fake image data'),
              mimetype,
              size,
              originalname: 'logo.png',
            } as Express.Multer.File;

            await expect(service.uploadLogo(file)).rejects.toThrow(BadRequestException);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should reject logo dimensions below 200x200px', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('image/png', 'image/jpeg'),
          fc.integer({ min: 1, max: 199 }),
          fc.integer({ min: 1, max: 199 }),
          async (mimetype, width, height) => {
            const file = {
              buffer: Buffer.from('fake image data'),
              mimetype,
              size: 1024,
              originalname: 'logo.png',
            } as Express.Multer.File;

            const mockDimensions = jest.fn().mockResolvedValue({ width, height });

            await expect(service.uploadLogo(file, mockDimensions)).rejects.toThrow(
              BadRequestException,
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should accept valid logos (PNG/JPG/SVG, ≤5MB, ≥200x200px)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('image/png', 'image/jpeg', 'image/svg+xml'),
          fc.integer({ min: 1, max: 5 * 1024 * 1024 }),
          fc.integer({ min: 200, max: 4000 }),
          fc.integer({ min: 200, max: 4000 }),
          async (mimetype, size, width, height) => {
            const file = {
              buffer: Buffer.from('fake image data'),
              mimetype,
              size,
              originalname: `logo.${mimetype === 'image/svg+xml' ? 'svg' : 'png'}`,
            } as Express.Multer.File;

            const mockDimensions = jest.fn().mockResolvedValue({ width, height });

            const result = await service.uploadLogo(file, mockDimensions);
            expect(result).toBeDefined();
            expect(result.url).toBeDefined();
            expect(result.sizeBytes).toBe(size);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ===== BICONDITIONAL PROPERTIES =====

  describe('Biconditional: DTO accepts if and only if all constraints are met', () => {
    it('voice tone accepted iff length ≤ 500 and non-empty', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 600 }),
          async (voiceTone) => {
            const data = {
              voiceTone,
              colorPalette: [{ hex: '#FF0000', name: 'Red', isPrimary: true }],
              targetAudience: 'Valid audience',
              differentials: ['Valid diff'],
              values: ['Valid value'],
            };
            const result = await validateBrandDto(data);
            const shouldBeValid = voiceTone.length >= 1 && voiceTone.length <= 500;
            expect(result.isValid).toBe(shouldBeValid);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('target audience accepted iff length ≤ 300 and non-empty', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 400 }),
          async (targetAudience) => {
            const data = {
              voiceTone: 'Valid tone',
              colorPalette: [{ hex: '#FF0000', name: 'Red', isPrimary: true }],
              targetAudience,
              differentials: ['Valid diff'],
              values: ['Valid value'],
            };
            const result = await validateBrandDto(data);
            const shouldBeValid = targetAudience.length >= 1 && targetAudience.length <= 300;
            expect(result.isValid).toBe(shouldBeValid);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('color palette accepted iff 1-6 items', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 10 }),
          async (count) => {
            const colors = Array.from({ length: count }, (_, i) => ({
              hex: `#${String(i).padStart(6, 'A')}`,
              name: `Color ${i}`,
              isPrimary: i === 0,
            }));
            const data = {
              voiceTone: 'Valid tone',
              colorPalette: colors,
              targetAudience: 'Valid audience',
              differentials: ['Valid diff'],
              values: ['Valid value'],
            };
            const result = await validateBrandDto(data);
            const shouldBeValid = count >= 1 && count <= 6;
            expect(result.isValid).toBe(shouldBeValid);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('differentials accepted iff 1-5 items by DTO', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 8 }),
          async (count) => {
            const differentials = Array.from({ length: count }, (_, i) => `Diff ${i}`);
            const data = {
              voiceTone: 'Valid tone',
              colorPalette: [{ hex: '#FF0000', name: 'Red', isPrimary: true }],
              targetAudience: 'Valid audience',
              differentials,
              values: ['Valid value'],
            };
            const result = await validateBrandDto(data);
            const shouldBeValid = count >= 1 && count <= 5;
            expect(result.isValid).toBe(shouldBeValid);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
