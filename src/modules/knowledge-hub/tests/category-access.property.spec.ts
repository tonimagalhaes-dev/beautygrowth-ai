import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException } from '@nestjs/common';

import { KnowledgeHubService } from '../services/knowledge-hub.service';
import { MockEmbeddingService } from '../services/embedding.service';
import { MockVectorStoreService } from '../services/vector-store.service';
import { Document } from '../entities/document.entity';
import { Category } from '../entities/category.entity';
import { EMBEDDING_SERVICE } from '../interfaces/embedding.interface';
import {
  VECTOR_STORE_SERVICE,
  KNOWLEDGE_COLLECTION,
  VectorPoint,
} from '../interfaces/vector-store.interface';
import { STORAGE_SERVICE } from '../../brand/interfaces/brand.interface';

/**
 * Property 13: Knowledge Hub — Acesso por Categoria
 *
 * For any agent configured with access to a subset of Knowledge Hub categories,
 * a semantic search executed by that agent MUST return ONLY chunks from documents
 * belonging to the authorized categories.
 *
 * **Validates: Requirements 8.6**
 */
describe('Property 13: Knowledge Hub — Category Access Control', () => {
  let service: KnowledgeHubService;
  let vectorStore: MockVectorStoreService;

  const tenantId = '11111111-1111-1111-1111-111111111111';

  // All available categories in the Knowledge Hub
  const ALL_CATEGORIES = [
    'institutional',
    'procedures',
    'marketing',
    'faq',
    'compliance',
    'clinical_protocols',
  ] as const;

  const mockDocumentRepository = {
    create: jest.fn((dto) => ({ ...dto, id: 'doc-id-1' })),
    save: jest.fn((entity) => Promise.resolve({ ...entity })),
    findOne: jest.fn(),
    find: jest.fn(),
    count: jest.fn(),
    remove: jest.fn(),
  };

  const mockCategoryRepository = {
    create: jest.fn((dto) => ({ ...dto, id: 'cat-id-1' })),
    save: jest.fn((entity) => Promise.resolve({ ...entity })),
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
  });

  /**
   * Helper: Seeds the vector store with chunks distributed across all categories
   * for the given tenant. Returns the points inserted.
   */
  async function seedVectorStore(
    categories: readonly string[],
    chunksPerCategory: number,
  ): Promise<VectorPoint[]> {
    await vectorStore.ensureCollection(KNOWLEDGE_COLLECTION, 1536);
    const embeddingService = new MockEmbeddingService();
    const allPoints: VectorPoint[] = [];

    for (const category of categories) {
      for (let i = 0; i < chunksPerCategory; i++) {
        const content = `Content for ${category} chunk ${i}`;
        const vector = await embeddingService.generateEmbedding(content);
        const point: VectorPoint = {
          id: `chunk-${category}-${i}`,
          vector,
          payload: {
            tenant_id: tenantId,
            document_id: `doc-${category}-${i}`,
            category,
            content,
            section: `section_${i}`,
            uploaded_at: new Date().toISOString(),
          },
        };
        allPoints.push(point);
      }
    }

    await vectorStore.upsertPoints(KNOWLEDGE_COLLECTION, allPoints);
    return allPoints;
  }

  // Arbitrary: generates a non-empty proper subset of ALL_CATEGORIES
  const authorizedCategoriesArb = fc
    .subarray([...ALL_CATEGORIES], { minLength: 1, maxLength: ALL_CATEGORIES.length - 1 })
    .filter((arr) => arr.length > 0 && arr.length < ALL_CATEGORIES.length);

  it(
    'search with authorizedCategories returns ONLY chunks from authorized categories',
    async () => {
      // Seed vector store with chunks across all categories
      await seedVectorStore(ALL_CATEGORIES, 3);

      await fc.assert(
        fc.asyncProperty(authorizedCategoriesArb, async (authorizedCategories) => {
          const results = await service.search(
            tenantId,
            'Content for',
            { topK: 10 },
            authorizedCategories,
          );

          // All returned chunks must belong to authorized categories
          for (const result of results) {
            const points = vectorStore.getPoints(KNOWLEDGE_COLLECTION);
            const point = points.find((p) => p.id === result.chunkId);
            expect(point).toBeDefined();
            expect(authorizedCategories).toContain(point!.payload.category);
          }
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    'search requesting unauthorized categories throws ForbiddenException',
    async () => {
      await seedVectorStore(ALL_CATEGORIES, 2);

      await fc.assert(
        fc.asyncProperty(
          // Generate authorized subset and a disjoint unauthorized subset
          fc
            .subarray([...ALL_CATEGORIES], { minLength: 1, maxLength: ALL_CATEGORIES.length - 1 })
            .filter((arr) => arr.length > 0 && arr.length < ALL_CATEGORIES.length)
            .chain((authorized) => {
              const unauthorized = ALL_CATEGORIES.filter(
                (c) => !authorized.includes(c),
              );
              // Pick at least 1 unauthorized category to request
              return fc
                .subarray(unauthorized, { minLength: 1 })
                .map((requestedUnauthorized) => ({
                  authorized,
                  requestedCategories: requestedUnauthorized,
                }));
            }),
          async ({ authorized, requestedCategories }) => {
            // Requesting categories the agent is NOT authorized for should throw
            await expect(
              service.search(
                tenantId,
                'test query',
                { topK: 5, categories: requestedCategories },
                authorized,
              ),
            ).rejects.toThrow(ForbiddenException);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    'search with no specific categories requested returns only authorized category chunks',
    async () => {
      await seedVectorStore(ALL_CATEGORIES, 3);

      await fc.assert(
        fc.asyncProperty(authorizedCategoriesArb, async (authorizedCategories) => {
          // When no explicit categories are passed in options, the service
          // should default to only searching within authorized categories
          const results = await service.search(
            tenantId,
            'Content for',
            { topK: 10 },
            authorizedCategories,
          );

          const points = vectorStore.getPoints(KNOWLEDGE_COLLECTION);
          for (const result of results) {
            const point = points.find((p) => p.id === result.chunkId);
            expect(point).toBeDefined();
            expect(authorizedCategories).toContain(point!.payload.category);
          }
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    'search with authorized subset intersection correctly limits results',
    async () => {
      await seedVectorStore(ALL_CATEGORIES, 3);

      await fc.assert(
        fc.asyncProperty(
          // Generate authorized categories and a requested subset that partially overlaps
          fc
            .subarray([...ALL_CATEGORIES], { minLength: 2, maxLength: ALL_CATEGORIES.length - 1 })
            .filter((arr) => arr.length >= 2)
            .chain((authorized) => {
              // Request a subset of the authorized categories (valid request)
              return fc
                .subarray(authorized, { minLength: 1, maxLength: authorized.length })
                .filter((sub) => sub.length > 0)
                .map((requestedCategories) => ({
                  authorized,
                  requestedCategories,
                }));
            }),
          async ({ authorized, requestedCategories }) => {
            const results = await service.search(
              tenantId,
              'Content for',
              { topK: 10, categories: requestedCategories },
              authorized,
            );

            // Results should only contain chunks from the requested subset
            // (which is within the authorized set)
            const points = vectorStore.getPoints(KNOWLEDGE_COLLECTION);
            for (const result of results) {
              const point = points.find((p) => p.id === result.chunkId);
              expect(point).toBeDefined();
              expect(requestedCategories).toContain(point!.payload.category);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
