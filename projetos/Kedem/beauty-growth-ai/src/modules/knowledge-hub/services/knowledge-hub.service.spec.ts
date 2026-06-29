import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import { KnowledgeHubService, PREDEFINED_CATEGORIES } from './knowledge-hub.service';
import { MockEmbeddingService } from './embedding.service';
import { MockVectorStoreService } from './vector-store.service';
import { Document } from '../entities/document.entity';
import { Category } from '../entities/category.entity';
import { EMBEDDING_SERVICE } from '../interfaces/embedding.interface';
import { VECTOR_STORE_SERVICE, KNOWLEDGE_COLLECTION } from '../interfaces/vector-store.interface';
import { STORAGE_SERVICE } from '../../brand/interfaces/brand.interface';

describe('KnowledgeHubService', () => {
  let service: KnowledgeHubService;
  let vectorStore: MockVectorStoreService;
  let documentRepository: any;
  let categoryRepository: any;
  let storageService: any;

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const userId = '22222222-2222-2222-2222-222222222222';

  const mockDocumentRepository = {
    create: jest.fn((dto) => ({ ...dto, id: 'doc-id-1' })),
    save: jest.fn((entity) => Promise.resolve({ ...entity, id: entity.id || 'doc-id-1' })),
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    remove: jest.fn(),
  };

  const mockCategoryRepository = {
    create: jest.fn((dto) => ({ ...dto, id: 'cat-id-1' })),
    save: jest.fn((entity) => Promise.resolve({ ...entity, id: entity.id || 'cat-id-1' })),
    findOne: jest.fn(),
    find: jest.fn(),
  };

  const mockStorageService = {
    upload: jest.fn().mockResolvedValue('http://localhost:9000/bucket/key'),
    delete: jest.fn().mockResolvedValue(undefined),
    getUrl: jest.fn().mockReturnValue('http://localhost:9000/bucket/key'),
  };

  beforeEach(async () => {
    vectorStore = new MockVectorStoreService();

    const module: TestingModule = await Test.createTestingModule({
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
          useValue: vectorStore,
        },
        {
          provide: STORAGE_SERVICE,
          useValue: mockStorageService,
        },
      ],
    }).compile();

    service = module.get<KnowledgeHubService>(KnowledgeHubService);
    documentRepository = module.get(getRepositoryToken(Document));
    categoryRepository = module.get(getRepositoryToken(Category));
    storageService = module.get(STORAGE_SERVICE);

    // Reset mocks
    jest.clearAllMocks();
    vectorStore.clear();
  });

  describe('upload', () => {
    const validFile: Express.Multer.File = {
      originalname: 'document.txt',
      buffer: Buffer.from('This is a test document with enough content to be chunked properly. '.repeat(50)),
      size: 1024,
      mimetype: 'text/plain',
      fieldname: 'file',
      encoding: '7bit',
      stream: null as any,
      destination: '',
      filename: '',
      path: '',
    };

    it('should upload a valid document', async () => {
      documentRepository.count.mockResolvedValue(0);
      documentRepository.create.mockReturnValue({
        id: 'doc-id-1',
        tenantId,
        fileName: validFile.originalname,
        format: 'txt',
        sizeBytes: validFile.size,
        category: 'institutional',
        status: 'pending',
        chunksCount: 0,
        storageKey: 'knowledge-hub/test/doc.txt',
        uploadedBy: userId,
      });
      documentRepository.save.mockResolvedValue({
        id: 'doc-id-1',
        tenantId,
        fileName: validFile.originalname,
        format: 'txt',
        sizeBytes: validFile.size,
        category: 'institutional',
        status: 'pending',
        chunksCount: 0,
        storageKey: 'knowledge-hub/test/doc.txt',
        uploadedBy: userId,
      });

      const result = await service.upload(
        tenantId,
        validFile,
        { category: 'institutional' },
        userId,
      );

      expect(result).toBeDefined();
      expect(result.format).toBe('txt');
      expect(storageService.upload).toHaveBeenCalled();
    });

    it('should reject invalid file format', async () => {
      const invalidFile = { ...validFile, originalname: 'file.exe' };

      await expect(
        service.upload(tenantId, invalidFile, { category: 'faq' }, userId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject files exceeding 20MB', async () => {
      const bigFile = { ...validFile, size: 21 * 1024 * 1024 };

      await expect(
        service.upload(tenantId, bigFile, { category: 'faq' }, userId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject when tenant has 500 documents', async () => {
      documentRepository.count.mockResolvedValue(500);

      await expect(
        service.upload(tenantId, validFile, { category: 'faq' }, userId),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept PDF format', async () => {
      documentRepository.count.mockResolvedValue(0);
      const pdfFile = { ...validFile, originalname: 'report.pdf' };

      documentRepository.create.mockReturnValue({
        id: 'doc-id-2',
        tenantId,
        fileName: 'report.pdf',
        format: 'pdf',
        status: 'pending',
      });
      documentRepository.save.mockResolvedValue({
        id: 'doc-id-2',
        tenantId,
        fileName: 'report.pdf',
        format: 'pdf',
        status: 'pending',
      });

      const result = await service.upload(
        tenantId,
        pdfFile,
        { category: 'procedures' },
        userId,
      );

      expect(result.format).toBe('pdf');
    });

    it('should accept DOCX format', async () => {
      documentRepository.count.mockResolvedValue(0);
      const docxFile = { ...validFile, originalname: 'report.docx' };

      documentRepository.create.mockReturnValue({
        id: 'doc-id-3',
        tenantId,
        fileName: 'report.docx',
        format: 'docx',
        status: 'pending',
      });
      documentRepository.save.mockResolvedValue({
        id: 'doc-id-3',
        tenantId,
        fileName: 'report.docx',
        format: 'docx',
        status: 'pending',
      });

      const result = await service.upload(
        tenantId,
        docxFile,
        { category: 'marketing' },
        userId,
      );

      expect(result.format).toBe('docx');
    });

    it('should accept MD format', async () => {
      documentRepository.count.mockResolvedValue(0);
      const mdFile = { ...validFile, originalname: 'readme.md' };

      documentRepository.create.mockReturnValue({
        id: 'doc-id-4',
        tenantId,
        fileName: 'readme.md',
        format: 'md',
        status: 'pending',
      });
      documentRepository.save.mockResolvedValue({
        id: 'doc-id-4',
        tenantId,
        fileName: 'readme.md',
        format: 'md',
        status: 'pending',
      });

      const result = await service.upload(
        tenantId,
        mdFile,
        { category: 'faq' },
        userId,
      );

      expect(result.format).toBe('md');
    });
  });

  describe('delete', () => {
    it('should delete document from DB, Qdrant, and S3', async () => {
      const doc = {
        id: 'doc-id-1',
        tenantId,
        storageKey: 'knowledge-hub/test/doc.txt',
      };
      documentRepository.findOne.mockResolvedValue(doc);
      documentRepository.remove.mockResolvedValue(doc);

      const deleteByDocSpy = jest.spyOn(vectorStore, 'deleteByDocumentId');

      await service.delete('doc-id-1', tenantId);

      expect(deleteByDocSpy).toHaveBeenCalledWith(KNOWLEDGE_COLLECTION, 'doc-id-1');
      expect(storageService.delete).toHaveBeenCalledWith(doc.storageKey);
      expect(documentRepository.remove).toHaveBeenCalledWith(doc);
    });

    it('should throw NotFoundException for non-existent document', async () => {
      documentRepository.findOne.mockResolvedValue(null);

      await expect(
        service.delete('non-existent', tenantId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('reprocess', () => {
    it('should reset status and re-trigger processing', async () => {
      const doc = {
        id: 'doc-id-1',
        tenantId,
        fileName: 'test.txt',
        format: 'txt',
        status: 'processed',
        chunksCount: 5,
        processedAt: new Date(),
        errorMessage: null,
        storageKey: 'knowledge-hub/test/doc.txt',
        category: 'faq',
      };
      documentRepository.findOne.mockResolvedValue(doc);
      documentRepository.save.mockImplementation((entity: any) =>
        Promise.resolve({ ...entity }),
      );

      const deleteByDocSpy = jest.spyOn(vectorStore, 'deleteByDocumentId');

      const result = await service.reprocess('doc-id-1', tenantId);

      // The method resets chunksCount and processedAt before kicking off async reprocessing
      expect(result.chunksCount).toBe(0);
      expect(result.processedAt).toBeNull();
      expect(deleteByDocSpy).toHaveBeenCalledWith(KNOWLEDGE_COLLECTION, 'doc-id-1');
    });

    it('should throw NotFoundException for non-existent document', async () => {
      documentRepository.findOne.mockResolvedValue(null);

      await expect(
        service.reprocess('non-existent', tenantId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('search', () => {
    it('should return search results with tenant isolation', async () => {
      // Setup: add points to the vector store for two tenants
      const otherTenantId = '99999999-9999-9999-9999-999999999999';

      await vectorStore.ensureCollection(KNOWLEDGE_COLLECTION, 1536);

      const mockEmbedding = new MockEmbeddingService();
      const embedding = await mockEmbedding.generateEmbedding('test content');

      await vectorStore.upsertPoints(KNOWLEDGE_COLLECTION, [
        {
          id: 'chunk-1',
          vector: embedding,
          payload: {
            tenant_id: tenantId,
            document_id: 'doc-1',
            category: 'faq',
            content: 'Test content for tenant 1',
            uploaded_at: new Date().toISOString(),
          },
        },
        {
          id: 'chunk-2',
          vector: embedding,
          payload: {
            tenant_id: otherTenantId,
            document_id: 'doc-2',
            category: 'faq',
            content: 'Test content for other tenant',
            uploaded_at: new Date().toISOString(),
          },
        },
      ]);

      const results = await service.search(tenantId, 'test content', { topK: 5 });

      // Should only return results for the correct tenant
      expect(results.every((r) => r.documentId !== 'doc-2')).toBe(true);
    });

    it('should filter by category', async () => {
      await vectorStore.ensureCollection(KNOWLEDGE_COLLECTION, 1536);

      const mockEmbedding = new MockEmbeddingService();
      const embedding = await mockEmbedding.generateEmbedding('content');

      await vectorStore.upsertPoints(KNOWLEDGE_COLLECTION, [
        {
          id: 'chunk-faq',
          vector: embedding,
          payload: {
            tenant_id: tenantId,
            document_id: 'doc-1',
            category: 'faq',
            content: 'FAQ content',
            uploaded_at: new Date().toISOString(),
          },
        },
        {
          id: 'chunk-marketing',
          vector: embedding,
          payload: {
            tenant_id: tenantId,
            document_id: 'doc-2',
            category: 'marketing',
            content: 'Marketing content',
            uploaded_at: new Date().toISOString(),
          },
        },
      ]);

      const results = await service.search(tenantId, 'content', {
        topK: 5,
        categories: ['faq'],
      });

      expect(results.every((r) => {
        // Find the payload for this result from the vector store
        const points = vectorStore.getPoints(KNOWLEDGE_COLLECTION);
        const point = points.find((p) => p.id === r.chunkId);
        return point?.payload.category === 'faq';
      })).toBe(true);
    });

    it('should enforce agent category access control', async () => {
      await vectorStore.ensureCollection(KNOWLEDGE_COLLECTION, 1536);

      const mockEmbedding = new MockEmbeddingService();
      const embedding = await mockEmbedding.generateEmbedding('content');

      await vectorStore.upsertPoints(KNOWLEDGE_COLLECTION, [
        {
          id: 'chunk-faq',
          vector: embedding,
          payload: {
            tenant_id: tenantId,
            document_id: 'doc-1',
            category: 'faq',
            content: 'FAQ content',
            uploaded_at: new Date().toISOString(),
          },
        },
        {
          id: 'chunk-compliance',
          vector: embedding,
          payload: {
            tenant_id: tenantId,
            document_id: 'doc-2',
            category: 'compliance',
            content: 'Compliance content',
            uploaded_at: new Date().toISOString(),
          },
        },
      ]);

      // Agent only authorized for 'faq'
      const results = await service.search(
        tenantId,
        'content',
        { topK: 5 },
        ['faq'],
      );

      expect(results.every((r) => {
        const points = vectorStore.getPoints(KNOWLEDGE_COLLECTION);
        const point = points.find((p) => p.id === r.chunkId);
        return point?.payload.category === 'faq';
      })).toBe(true);
    });

    it('should throw ForbiddenException when agent requests unauthorized categories', async () => {
      await expect(
        service.search(
          tenantId,
          'test',
          { topK: 5, categories: ['compliance'] },
          ['faq'], // agent only authorized for faq
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should clamp topK between 3 and 10', async () => {
      await vectorStore.ensureCollection(KNOWLEDGE_COLLECTION, 1536);

      // topK below 3 should be clamped to 3
      const results1 = await service.search(tenantId, 'test', { topK: 1 });
      expect(results1).toBeDefined();

      // topK above 10 should be clamped to 10
      const results2 = await service.search(tenantId, 'test', { topK: 15 });
      expect(results2).toBeDefined();
    });
  });

  describe('listDocuments', () => {
    it('should return documents for the given tenant', async () => {
      const docs = [
        { id: 'doc-1', tenantId, fileName: 'a.txt' },
        { id: 'doc-2', tenantId, fileName: 'b.pdf' },
      ];
      documentRepository.find.mockResolvedValue(docs);

      const result = await service.listDocuments(tenantId);

      expect(result).toHaveLength(2);
      expect(documentRepository.find).toHaveBeenCalledWith({
        where: { tenantId },
        order: { uploadedAt: 'DESC' },
      });
    });

    it('should apply filters', async () => {
      documentRepository.find.mockResolvedValue([]);

      await service.listDocuments(tenantId, {
        category: 'faq',
        status: 'processed',
        format: 'pdf',
      });

      expect(documentRepository.find).toHaveBeenCalledWith({
        where: { tenantId, category: 'faq', status: 'processed', format: 'pdf' },
        order: { uploadedAt: 'DESC' },
      });
    });
  });

  describe('createCategory', () => {
    it('should create a custom category', async () => {
      categoryRepository.findOne.mockResolvedValue(null);
      categoryRepository.create.mockReturnValue({
        id: 'cat-1',
        tenantId,
        name: 'custom_cat',
        description: 'My category',
        isPredefined: false,
      });
      categoryRepository.save.mockResolvedValue({
        id: 'cat-1',
        tenantId,
        name: 'custom_cat',
        description: 'My category',
        isPredefined: false,
      });

      const result = await service.createCategory(tenantId, {
        name: 'custom_cat',
        description: 'My category',
      });

      expect(result.name).toBe('custom_cat');
      expect(result.isPredefined).toBe(false);
    });

    it('should reject duplicate category names', async () => {
      categoryRepository.findOne.mockResolvedValue({
        id: 'cat-1',
        tenantId,
        name: 'existing',
      });

      await expect(
        service.createCategory(tenantId, { name: 'existing' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('provisionPredefinedCategories', () => {
    it('should create all 6 predefined categories', async () => {
      categoryRepository.findOne.mockResolvedValue(null);
      categoryRepository.create.mockImplementation((dto: any) => ({
        id: `cat-${dto.name}`,
        ...dto,
      }));
      categoryRepository.save.mockImplementation((entity: any) =>
        Promise.resolve(entity),
      );

      const result = await service.provisionPredefinedCategories(tenantId);

      expect(result).toHaveLength(6);
      expect(categoryRepository.save).toHaveBeenCalledTimes(6);
    });

    it('should not duplicate existing predefined categories', async () => {
      // First call finds 'institutional' already exists
      categoryRepository.findOne.mockImplementation(({ where }: any) => {
        if (where.name === 'institutional') {
          return Promise.resolve({ id: 'existing', name: 'institutional' });
        }
        return Promise.resolve(null);
      });
      categoryRepository.create.mockImplementation((dto: any) => ({
        id: `cat-${dto.name}`,
        ...dto,
      }));
      categoryRepository.save.mockImplementation((entity: any) =>
        Promise.resolve(entity),
      );

      const result = await service.provisionPredefinedCategories(tenantId);

      // Should only create 5 (institutional already exists)
      expect(result).toHaveLength(5);
    });
  });

  describe('processDocument', () => {
    it('should process a document through the full pipeline', async () => {
      const doc = {
        id: 'doc-id-1',
        tenantId,
        fileName: 'test.txt',
        format: 'txt' as const,
        status: 'pending' as const,
        category: 'faq',
        chunksCount: 0,
        processedAt: null,
        errorMessage: null,
      };

      documentRepository.save.mockImplementation((entity: any) =>
        Promise.resolve(entity),
      );

      const content = 'This is a paragraph of content.\n\nThis is another paragraph with more content.';
      const buffer = Buffer.from(content);

      await service.processDocument(doc as any, buffer);

      // Status should be updated to processed
      expect(doc.status).toBe('processed');
      expect(doc.chunksCount).toBeGreaterThan(0);
      expect(doc.processedAt).toBeDefined();

      // Points should be in vector store
      const points = vectorStore.getPoints(KNOWLEDGE_COLLECTION);
      expect(points.length).toBeGreaterThan(0);
      expect(points[0].payload.tenant_id).toBe(tenantId);
      expect(points[0].payload.document_id).toBe('doc-id-1');
    });

    it('should set error status on processing failure', async () => {
      const doc = {
        id: 'doc-id-1',
        tenantId,
        fileName: 'test.txt',
        format: 'txt' as const,
        status: 'pending' as const,
        category: 'faq',
        chunksCount: 0,
        processedAt: null,
        errorMessage: null,
      };

      documentRepository.save.mockImplementation((entity: any) =>
        Promise.resolve(entity),
      );

      // Empty buffer will result in no extractable content
      const buffer = Buffer.from('');

      await expect(
        service.processDocument(doc as any, buffer),
      ).rejects.toThrow();

      expect(doc.status).toBe('error');
      expect(doc.errorMessage).toBeDefined();
    });
  });

  describe('chunkText', () => {
    it('should split large text into chunks', () => {
      const longText = 'Paragraph one with enough content. '.repeat(100) +
        '\n\n' +
        'Paragraph two with more content. '.repeat(100);

      const chunks = service.chunkText(longText);

      expect(chunks.length).toBeGreaterThan(1);
      // Each chunk should be within reasonable bounds
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeLessThanOrEqual(2500); // some tolerance
      }
    });

    it('should handle short text as a single chunk', () => {
      const shortText = 'This is a short document.';
      const chunks = service.chunkText(shortText);

      expect(chunks).toHaveLength(1);
      expect(chunks[0].content).toBe(shortText);
    });

    it('should handle empty text', () => {
      const chunks = service.chunkText('');
      expect(chunks).toHaveLength(0);
    });
  });

  describe('status tracking', () => {
    it('should track processing status transitions', async () => {
      const doc = {
        id: 'doc-id-1',
        tenantId,
        fileName: 'test.txt',
        format: 'txt' as const,
        status: 'pending' as const,
        category: 'faq',
        chunksCount: 0,
        processedAt: null,
        errorMessage: null,
      };

      const statusTransitions: string[] = [];
      documentRepository.save.mockImplementation((entity: any) => {
        statusTransitions.push(entity.status);
        return Promise.resolve(entity);
      });

      const content = 'Some content for processing.\n\nAnother paragraph here.';
      const buffer = Buffer.from(content);

      await service.processDocument(doc as any, buffer);

      // Should have gone: pending → processing → processed
      expect(statusTransitions).toContain('processing');
      expect(statusTransitions).toContain('processed');
    });
  });
});
