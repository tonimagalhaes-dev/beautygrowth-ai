import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';

import { KnowledgeHubService } from '../services/knowledge-hub.service';
import { MockEmbeddingService } from '../services/embedding.service';
import { MockVectorStoreService } from '../services/vector-store.service';
import { Document } from '../entities/document.entity';
import { Category } from '../entities/category.entity';
import { EMBEDDING_SERVICE } from '../interfaces/embedding.interface';
import {
  VECTOR_STORE_SERVICE,
  KNOWLEDGE_COLLECTION,
} from '../interfaces/vector-store.interface';
import { STORAGE_SERVICE } from '../../brand/interfaces/brand.interface';

/**
 * Property 14: Knowledge Hub — Exclusão Remove Chunks
 *
 * For any document that has been uploaded and processed (i.e., has chunks
 * in the vector store), when that document is deleted, ALL its chunks MUST
 * be removed from the vector store, and subsequent semantic searches MUST
 * return zero results for that document_id.
 *
 * This test:
 * 1. Generates random documents (tenantId, documentId, content producing chunks)
 * 2. Processes them to insert chunks into the mock vector store
 * 3. Verifies chunks exist for the document
 * 4. Deletes the document
 * 5. Verifies deleteByDocumentId was called
 * 6. Verifies subsequent search returns zero chunks for that document_id
 *
 * **Validates: Requirements 8.7**
 */

// -- Arbitraries --

/** Random UUID-like tenant id */
const tenantIdArb = fc.uuid();

/** Random UUID-like document id */
const documentIdArb = fc.uuid();

/** Random UUID-like user id */
const userIdArb = fc.uuid();

/** Random category from predefined set */
const categoryArb = fc.constantFrom(
  'institutional',
  'procedures',
  'marketing',
  'faq',
  'compliance',
  'clinical_protocols',
);

/** Random document content — multiple paragraphs to ensure chunking */
const documentContentArb = fc.array(
  fc.string({ minLength: 50, maxLength: 300 }),
  { minLength: 1, maxLength: 5 },
).map((paragraphs) => paragraphs.join('\n\n'));

/** Full scenario input */
const scenarioArb = fc.record({
  tenantId: tenantIdArb,
  documentId: documentIdArb,
  userId: userIdArb,
  category: categoryArb,
  content: documentContentArb,
});

describe('Property 14: Knowledge Hub — Exclusão Remove Chunks', () => {
  let service: KnowledgeHubService;
  let vectorStore: MockVectorStoreService;
  let documentRepository: Record<string, jest.Mock>;
  let storageService: Record<string, jest.Mock>;

  beforeEach(async () => {
    vectorStore = new MockVectorStoreService();

    documentRepository = {
      create: jest.fn((dto) => ({ ...dto })),
      save: jest.fn((entity) => Promise.resolve({ ...entity })),
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      remove: jest.fn().mockResolvedValue(undefined),
    };

    storageService = {
      upload: jest.fn().mockResolvedValue('http://localhost:9000/bucket/key'),
      delete: jest.fn().mockResolvedValue(undefined),
      getUrl: jest.fn().mockReturnValue('http://localhost:9000/bucket/key'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KnowledgeHubService,
        {
          provide: getRepositoryToken(Document),
          useValue: documentRepository,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
          },
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
          useValue: storageService,
        },
      ],
    }).compile();

    service = module.get<KnowledgeHubService>(KnowledgeHubService);
  });

  it('should remove ALL chunks from vector store after document deletion and subsequent search returns zero results for that document_id', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        // Clear vector store between iterations
        vectorStore.clear();

        const { tenantId, documentId, category, content } = scenario;
        const storageKey = `knowledge-hub/${tenantId}/${documentId}.txt`;

        // Step 1: Simulate a processed document by running processDocument
        const doc = {
          id: documentId,
          tenantId,
          fileName: 'test-document.txt',
          format: 'txt' as const,
          status: 'pending' as const,
          category,
          chunksCount: 0,
          processedAt: null,
          errorMessage: null,
          storageKey,
          uploadedBy: scenario.userId,
        };

        documentRepository.save.mockImplementation((entity: any) =>
          Promise.resolve({ ...entity }),
        );

        // Process document to insert chunks into vector store
        const buffer = Buffer.from(content);
        await service.processDocument(doc as any, buffer);

        // Step 2: Verify chunks exist in the vector store for this document
        const pointsBefore = vectorStore.getPoints(KNOWLEDGE_COLLECTION);
        const docChunksBefore = pointsBefore.filter(
          (p) => p.payload.document_id === documentId,
        );
        expect(docChunksBefore.length).toBeGreaterThan(0);

        // Step 3: Setup findOne mock for delete operation
        documentRepository.findOne.mockResolvedValue({
          id: documentId,
          tenantId,
          storageKey,
        });

        // Step 4: Delete the document
        const deleteByDocSpy = jest.spyOn(vectorStore, 'deleteByDocumentId');
        await service.delete(documentId, tenantId);

        // Step 5: Verify deleteByDocumentId was called with correct params
        expect(deleteByDocSpy).toHaveBeenCalledWith(
          KNOWLEDGE_COLLECTION,
          documentId,
        );

        // Step 6: Verify zero chunks remain for this document_id
        const pointsAfter = vectorStore.getPoints(KNOWLEDGE_COLLECTION);
        const docChunksAfter = pointsAfter.filter(
          (p) => p.payload.document_id === documentId,
        );
        expect(docChunksAfter.length).toBe(0);

        // Step 7: Verify a search for this tenant returns nothing from the deleted doc
        const searchResults = await vectorStore.search(
          KNOWLEDGE_COLLECTION,
          new Array(1536).fill(0.1), // arbitrary query vector
          { tenant_id: tenantId },
          10,
        );
        const resultsFromDeletedDoc = searchResults.filter(
          (r) => r.payload.document_id === documentId,
        );
        expect(resultsFromDeletedDoc.length).toBe(0);

        // Cleanup spy
        deleteByDocSpy.mockRestore();
      }),
      { numRuns: 100 },
    );
  });

  it('should not affect chunks from OTHER documents in the same tenant after deletion', async () => {
    await fc.assert(
      fc.asyncProperty(
        scenarioArb,
        documentIdArb,
        documentContentArb,
        async (scenario, otherDocId, otherContent) => {
          // Skip if both doc IDs happen to be the same
          if (scenario.documentId === otherDocId) return;

          // Clear vector store between iterations
          vectorStore.clear();

          const { tenantId, documentId, category } = scenario;

          documentRepository.save.mockImplementation((entity: any) =>
            Promise.resolve({ ...entity }),
          );

          // Process the first document (to be deleted)
          const doc1 = {
            id: documentId,
            tenantId,
            fileName: 'doc1.txt',
            format: 'txt' as const,
            status: 'pending' as const,
            category,
            chunksCount: 0,
            processedAt: null,
            errorMessage: null,
            storageKey: `knowledge-hub/${tenantId}/${documentId}.txt`,
            uploadedBy: scenario.userId,
          };
          await service.processDocument(doc1 as any, Buffer.from(scenario.content));

          // Process the second document (should survive deletion)
          const doc2 = {
            id: otherDocId,
            tenantId,
            fileName: 'doc2.txt',
            format: 'txt' as const,
            status: 'pending' as const,
            category,
            chunksCount: 0,
            processedAt: null,
            errorMessage: null,
            storageKey: `knowledge-hub/${tenantId}/${otherDocId}.txt`,
            uploadedBy: scenario.userId,
          };
          await service.processDocument(doc2 as any, Buffer.from(otherContent));

          // Count chunks for the OTHER document before deletion
          const otherChunksBefore = vectorStore
            .getPoints(KNOWLEDGE_COLLECTION)
            .filter((p) => p.payload.document_id === otherDocId);
          const otherChunksCountBefore = otherChunksBefore.length;

          // Delete the first document
          documentRepository.findOne.mockResolvedValue({
            id: documentId,
            tenantId,
            storageKey: doc1.storageKey,
          });
          await service.delete(documentId, tenantId);

          // Verify other document chunks remain intact
          const otherChunksAfter = vectorStore
            .getPoints(KNOWLEDGE_COLLECTION)
            .filter((p) => p.payload.document_id === otherDocId);
          expect(otherChunksAfter.length).toBe(otherChunksCountBefore);

          // Verify search still returns results from the other document
          const searchResults = await vectorStore.search(
            KNOWLEDGE_COLLECTION,
            new Array(1536).fill(0.1),
            { tenant_id: tenantId },
            10,
          );
          const survivingResults = searchResults.filter(
            (r) => r.payload.document_id === otherDocId,
          );
          // If there were chunks before, some should still be searchable
          if (otherChunksCountBefore > 0) {
            expect(survivingResults.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should call storageService.delete and documentRepository.remove on deletion', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        vectorStore.clear();

        const { tenantId, documentId, category, content } = scenario;
        const storageKey = `knowledge-hub/${tenantId}/${documentId}.txt`;

        documentRepository.save.mockImplementation((entity: any) =>
          Promise.resolve({ ...entity }),
        );

        // Process to create chunks
        const doc = {
          id: documentId,
          tenantId,
          fileName: 'test.txt',
          format: 'txt' as const,
          status: 'pending' as const,
          category,
          chunksCount: 0,
          processedAt: null,
          errorMessage: null,
          storageKey,
          uploadedBy: scenario.userId,
        };
        await service.processDocument(doc as any, Buffer.from(content));

        // Setup for delete
        const docRecord = { id: documentId, tenantId, storageKey };
        documentRepository.findOne.mockResolvedValue(docRecord);
        storageService.delete.mockClear();
        documentRepository.remove.mockClear();

        // Delete
        await service.delete(documentId, tenantId);

        // Verify S3 and DB cleanup
        expect(storageService.delete).toHaveBeenCalledWith(storageKey);
        expect(documentRepository.remove).toHaveBeenCalledWith(docRecord);
      }),
      { numRuns: 100 },
    );
  });
});
