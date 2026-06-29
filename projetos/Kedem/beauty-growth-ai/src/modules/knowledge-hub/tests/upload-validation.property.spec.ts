import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';

import { KnowledgeHubService } from '../services/knowledge-hub.service';
import { MockEmbeddingService } from '../services/embedding.service';
import { MockVectorStoreService } from '../services/vector-store.service';
import { Document } from '../entities/document.entity';
import { Category } from '../entities/category.entity';
import { EMBEDDING_SERVICE } from '../interfaces/embedding.interface';
import { VECTOR_STORE_SERVICE } from '../interfaces/vector-store.interface';
import { STORAGE_SERVICE } from '../../brand/interfaces/brand.interface';

/**
 * Property 15: Upload de Documentos — Validação
 *
 * Generate files with valid/invalid formats and sizes, verify acceptance criteria.
 * Valid: PDF/DOCX/TXT/MD, ≤20MB. Invalid: other formats, >20MB.
 *
 * **Validates: Requirements 8.1, 8.8**
 */

// --- Constants (mirroring service constants) ---
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const ALLOWED_FORMATS = ['pdf', 'docx', 'txt', 'md'] as const;
const MAX_DOCS_PER_TENANT = 500;

// --- Arbitraries ---

const validFormats = fc.constantFrom(...ALLOWED_FORMATS);

const invalidFormats = fc.constantFrom(
  'exe', 'jpg', 'png', 'gif', 'zip', 'tar', 'csv', 'xls', 'xlsx',
  'ppt', 'pptx', 'html', 'xml', 'json', 'yaml', 'sql', 'mp3', 'mp4',
  'avi', 'wav', 'bmp', 'svg', 'iso', 'dmg', 'bin', 'dll', 'so',
);

const validFileSize = fc.integer({ min: 1, max: MAX_FILE_SIZE });

const invalidFileSize = fc.integer({ min: MAX_FILE_SIZE + 1, max: MAX_FILE_SIZE * 2 });

const validCategory = fc.constantFrom(
  'institutional', 'procedures', 'marketing', 'faq', 'compliance', 'clinical_protocols',
);

const tenantIdArb = fc.uuid();
const userIdArb = fc.uuid();

/** Build a mock Express.Multer.File */
function buildMockFile(originalname: string, size: number): Express.Multer.File {
  return {
    originalname,
    buffer: Buffer.alloc(Math.min(size, 1024)), // don't allocate huge buffers for speed
    size,
    mimetype: 'application/octet-stream',
    fieldname: 'file',
    encoding: '7bit',
    stream: null as any,
    destination: '',
    filename: '',
    path: '',
  };
}

// --- Test Setup ---

describe('Property 15: Upload de Documentos — Validação', () => {
  let service: KnowledgeHubService;
  let module: TestingModule;
  let documentRepository: any;

  const mockDocumentRepository = {
    create: jest.fn((dto) => ({ ...dto, id: 'doc-id-generated' })),
    save: jest.fn((entity) => Promise.resolve({ ...entity, id: entity.id || 'doc-id-generated' })),
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    remove: jest.fn(),
  };

  const mockCategoryRepository = {
    create: jest.fn((dto) => ({ ...dto, id: 'cat-id-1' })),
    save: jest.fn((entity) => Promise.resolve(entity)),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const mockStorageService = {
    upload: jest.fn().mockResolvedValue('http://localhost:9000/bucket/key'),
    delete: jest.fn().mockResolvedValue(undefined),
    getUrl: jest.fn().mockReturnValue('http://localhost:9000/bucket/key'),
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      providers: [
        KnowledgeHubService,
        {
          provide: getRepositoryToken(Document),
          useValue: mockDocumentRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: mockCategoryRepository,
        },
        {
          provide: EMBEDDING_SERVICE,
          useClass: MockEmbeddingService,
        },
        {
          provide: VECTOR_STORE_SERVICE,
          useClass: MockVectorStoreService,
        },
        {
          provide: STORAGE_SERVICE,
          useValue: mockStorageService,
        },
      ],
    }).compile();

    service = module.get<KnowledgeHubService>(KnowledgeHubService);
    documentRepository = module.get(getRepositoryToken(Document));
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDocumentRepository.count.mockResolvedValue(0);
  });

  // ===== FORMAT VALIDATION =====

  describe('Format validation: accepts valid formats (PDF, DOCX, TXT, MD)', () => {
    it('should accept files with valid formats', async () => {
      await fc.assert(
        fc.asyncProperty(
          validFormats,
          validFileSize,
          validCategory,
          tenantIdArb,
          userIdArb,
          async (format, size, category, tenantId, userId) => {
            mockDocumentRepository.count.mockResolvedValue(0);
            mockDocumentRepository.create.mockReturnValue({
              id: 'doc-id',
              tenantId,
              fileName: `document.${format}`,
              format,
              sizeBytes: size,
              category,
              status: 'pending',
              chunksCount: 0,
              storageKey: `knowledge-hub/${tenantId}/doc.${format}`,
              uploadedBy: userId,
            });
            mockDocumentRepository.save.mockImplementation((entity: any) =>
              Promise.resolve({ ...entity }),
            );

            const file = buildMockFile(`document.${format}`, size);

            const result = await service.upload(tenantId, file, { category }, userId);

            expect(result).toBeDefined();
            expect(result.format).toBe(format);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Format validation: rejects invalid formats', () => {
    it('should reject files with invalid formats', async () => {
      await fc.assert(
        fc.asyncProperty(
          invalidFormats,
          validFileSize,
          validCategory,
          tenantIdArb,
          userIdArb,
          async (format, size, category, tenantId, userId) => {
            const file = buildMockFile(`document.${format}`, size);

            await expect(
              service.upload(tenantId, file, { category }, userId),
            ).rejects.toThrow(BadRequestException);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ===== SIZE VALIDATION =====

  describe('Size validation: accepts files ≤ 20MB', () => {
    it('should accept files at or below 20MB', async () => {
      await fc.assert(
        fc.asyncProperty(
          validFormats,
          validFileSize,
          validCategory,
          tenantIdArb,
          userIdArb,
          async (format, size, category, tenantId, userId) => {
            mockDocumentRepository.count.mockResolvedValue(0);
            mockDocumentRepository.create.mockReturnValue({
              id: 'doc-id',
              tenantId,
              fileName: `file.${format}`,
              format,
              sizeBytes: size,
              category,
              status: 'pending',
              chunksCount: 0,
              storageKey: `knowledge-hub/${tenantId}/file.${format}`,
              uploadedBy: userId,
            });
            mockDocumentRepository.save.mockImplementation((entity: any) =>
              Promise.resolve({ ...entity }),
            );

            const file = buildMockFile(`file.${format}`, size);

            const result = await service.upload(tenantId, file, { category }, userId);

            expect(result).toBeDefined();
            expect(result.sizeBytes).toBe(size);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Size validation: rejects files > 20MB', () => {
    it('should reject files exceeding 20MB', async () => {
      await fc.assert(
        fc.asyncProperty(
          validFormats,
          invalidFileSize,
          validCategory,
          tenantIdArb,
          userIdArb,
          async (format, size, category, tenantId, userId) => {
            const file = buildMockFile(`file.${format}`, size);

            await expect(
              service.upload(tenantId, file, { category }, userId),
            ).rejects.toThrow(BadRequestException);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ===== DOCUMENT COUNT LIMIT =====

  describe('Document count validation: rejects when tenant has 500 docs', () => {
    it('should reject upload when tenant reaches 500 documents', async () => {
      await fc.assert(
        fc.asyncProperty(
          validFormats,
          validFileSize,
          validCategory,
          tenantIdArb,
          userIdArb,
          fc.integer({ min: MAX_DOCS_PER_TENANT, max: MAX_DOCS_PER_TENANT + 100 }),
          async (format, size, category, tenantId, userId, docCount) => {
            mockDocumentRepository.count.mockResolvedValue(docCount);

            const file = buildMockFile(`file.${format}`, size);

            await expect(
              service.upload(tenantId, file, { category }, userId),
            ).rejects.toThrow(BadRequestException);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Document count validation: accepts when tenant has < 500 docs', () => {
    it('should accept upload when tenant is below 500 documents', async () => {
      await fc.assert(
        fc.asyncProperty(
          validFormats,
          validFileSize,
          validCategory,
          tenantIdArb,
          userIdArb,
          fc.integer({ min: 0, max: MAX_DOCS_PER_TENANT - 1 }),
          async (format, size, category, tenantId, userId, docCount) => {
            mockDocumentRepository.count.mockResolvedValue(docCount);
            mockDocumentRepository.create.mockReturnValue({
              id: 'doc-id',
              tenantId,
              fileName: `file.${format}`,
              format,
              sizeBytes: size,
              category,
              status: 'pending',
              chunksCount: 0,
              storageKey: `knowledge-hub/${tenantId}/file.${format}`,
              uploadedBy: userId,
            });
            mockDocumentRepository.save.mockImplementation((entity: any) =>
              Promise.resolve({ ...entity }),
            );

            const file = buildMockFile(`file.${format}`, size);

            const result = await service.upload(tenantId, file, { category }, userId);

            expect(result).toBeDefined();
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ===== BICONDITIONAL: ACCEPTANCE IFF ALL CRITERIA MET =====

  describe('Biconditional: upload accepts iff format is valid AND size ≤ 20MB AND doc count < 500', () => {
    it('should accept or reject based on combined validity of all criteria', async () => {
      const formatArb = fc.oneof(validFormats, invalidFormats);
      const sizeArb = fc.oneof(validFileSize, invalidFileSize);
      const docCountArb = fc.integer({ min: 0, max: MAX_DOCS_PER_TENANT + 50 });

      await fc.assert(
        fc.asyncProperty(
          formatArb,
          sizeArb,
          validCategory,
          tenantIdArb,
          userIdArb,
          docCountArb,
          async (format, size, category, tenantId, userId, docCount) => {
            mockDocumentRepository.count.mockResolvedValue(docCount);
            mockDocumentRepository.create.mockReturnValue({
              id: 'doc-id',
              tenantId,
              fileName: `file.${format}`,
              format,
              sizeBytes: size,
              category,
              status: 'pending',
              chunksCount: 0,
              storageKey: `knowledge-hub/${tenantId}/file.${format}`,
              uploadedBy: userId,
            });
            mockDocumentRepository.save.mockImplementation((entity: any) =>
              Promise.resolve({ ...entity }),
            );

            const file = buildMockFile(`file.${format}`, size);

            const isValidFormat = (ALLOWED_FORMATS as readonly string[]).includes(format);
            const isValidSize = size <= MAX_FILE_SIZE;
            const isValidDocCount = docCount < MAX_DOCS_PER_TENANT;
            const shouldAccept = isValidFormat && isValidSize && isValidDocCount;

            if (shouldAccept) {
              const result = await service.upload(tenantId, file, { category }, userId);
              expect(result).toBeDefined();
            } else {
              await expect(
                service.upload(tenantId, file, { category }, userId),
              ).rejects.toThrow(BadRequestException);
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
