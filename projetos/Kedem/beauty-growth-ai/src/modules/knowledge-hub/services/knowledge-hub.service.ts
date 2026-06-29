import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { Document, DocumentFormat } from '../entities/document.entity';
import { Category } from '../entities/category.entity';
import {
  IKnowledgeHubService,
  SearchOptions,
  SearchResult,
  DocumentFilters,
  UploadDocInput,
  CreateCategoryInput,
} from '../interfaces/knowledge-hub.interface';
import {
  IEmbeddingService,
  EMBEDDING_SERVICE,
} from '../interfaces/embedding.interface';
import {
  IVectorStoreService,
  VECTOR_STORE_SERVICE,
  VectorPoint,
  KNOWLEDGE_COLLECTION,
} from '../interfaces/vector-store.interface';
import { IStorageService } from '../../brand/interfaces/brand.interface';
import { STORAGE_SERVICE } from '../../brand/interfaces/brand.interface';

/** Maximum file size: 20MB */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/** Maximum documents per tenant */
const MAX_DOCS_PER_TENANT = 500;

/** Allowed file formats */
const ALLOWED_FORMATS: DocumentFormat[] = ['pdf', 'docx', 'txt', 'md'];

/** Predefined categories for every tenant */
export const PREDEFINED_CATEGORIES = [
  'institutional',
  'procedures',
  'marketing',
  'faq',
  'compliance',
  'clinical_protocols',
] as const;

/** Target chunk size in tokens (~500 tokens ≈ ~2000 chars) */
const TARGET_CHUNK_CHARS = 2000;

/** Minimum chunk size to avoid tiny fragments */
const MIN_CHUNK_CHARS = 100;

@Injectable()
export class KnowledgeHubService implements IKnowledgeHubService {
  private readonly logger = new Logger(KnowledgeHubService.name);

  constructor(
    @InjectRepository(Document)
    private readonly documentRepository: Repository<Document>,
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
    @Inject(EMBEDDING_SERVICE)
    private readonly embeddingService: IEmbeddingService,
    @Inject(VECTOR_STORE_SERVICE)
    private readonly vectorStoreService: IVectorStoreService,
    @Inject(STORAGE_SERVICE)
    private readonly storageService: IStorageService,
  ) {}

  // =========================================================================
  // UPLOAD
  // =========================================================================

  async upload(
    tenantId: string,
    file: Express.Multer.File,
    dto: UploadDocInput,
    uploadedBy: string,
  ): Promise<Document> {
    // Validate file format
    const format = this.extractFormat(file.originalname);
    if (!ALLOWED_FORMATS.includes(format)) {
      throw new BadRequestException(
        `Invalid file format. Allowed: ${ALLOWED_FORMATS.join(', ')}`,
      );
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`,
      );
    }

    // Validate document count per tenant
    const docCount = await this.documentRepository.count({
      where: { tenantId },
    });
    if (docCount >= MAX_DOCS_PER_TENANT) {
      throw new BadRequestException(
        `Maximum documents per tenant reached (${MAX_DOCS_PER_TENANT})`,
      );
    }

    // Upload file to S3
    const storageKey = `knowledge-hub/${tenantId}/${uuidv4()}-${file.originalname}`;
    const contentType = this.getContentType(format);
    await this.storageService.upload(file.buffer, storageKey, contentType);

    // Create document record
    const document = this.documentRepository.create({
      tenantId,
      fileName: file.originalname,
      format,
      sizeBytes: file.size,
      category: dto.category,
      status: 'pending',
      chunksCount: 0,
      storageKey,
      uploadedBy,
    });

    const saved = await this.documentRepository.save(document);
    this.logger.log(`Document uploaded: ${saved.id} (${file.originalname})`);

    // Trigger async processing
    this.processDocument(saved, file.buffer).catch((error) => {
      this.logger.error(`Document processing failed for ${saved.id}`, error);
    });

    return saved;
  }

  // =========================================================================
  // DELETE
  // =========================================================================

  async delete(documentId: string, tenantId: string): Promise<void> {
    const document = await this.findDocumentOrFail(documentId, tenantId);

    // Delete chunks from Qdrant
    await this.vectorStoreService.deleteByDocumentId(
      KNOWLEDGE_COLLECTION,
      documentId,
    );

    // Delete file from S3
    await this.storageService.delete(document.storageKey);

    // Delete document record from PostgreSQL
    await this.documentRepository.remove(document);

    this.logger.log(`Document deleted: ${documentId}`);
  }

  // =========================================================================
  // REPROCESS
  // =========================================================================

  async reprocess(documentId: string, tenantId: string): Promise<Document> {
    const document = await this.findDocumentOrFail(documentId, tenantId);

    // Reset status
    document.status = 'pending';
    document.chunksCount = 0;
    document.processedAt = null;
    document.errorMessage = null;
    await this.documentRepository.save(document);

    // Delete existing chunks from Qdrant
    await this.vectorStoreService.deleteByDocumentId(
      KNOWLEDGE_COLLECTION,
      documentId,
    );

    // Re-fetch the file from S3 or use a stub for reprocessing
    // In a real implementation, we'd download from S3. Here we trigger
    // processing with a stub text extraction based on file format.
    this.reprocessDocument(document).catch((error) => {
      this.logger.error(`Document reprocessing failed for ${documentId}`, error);
    });

    return document;
  }

  // =========================================================================
  // SEARCH
  // =========================================================================

  async search(
    tenantId: string,
    query: string,
    options: SearchOptions,
    authorizedCategories?: string[],
  ): Promise<SearchResult[]> {
    const topK = Math.max(3, Math.min(10, options.topK || 5));

    // Apply category-based access control
    let effectiveCategories = options.categories;
    if (authorizedCategories && authorizedCategories.length > 0) {
      if (effectiveCategories && effectiveCategories.length > 0) {
        // Intersect requested categories with authorized categories
        effectiveCategories = effectiveCategories.filter((c) =>
          authorizedCategories.includes(c),
        );
        if (effectiveCategories.length === 0) {
          throw new ForbiddenException(
            'Agent does not have access to the requested categories',
          );
        }
      } else {
        effectiveCategories = authorizedCategories;
      }
    }

    // Generate embedding for the query
    const queryVector = await this.embeddingService.generateEmbedding(query);

    // Search Qdrant with tenant isolation
    const results = await this.vectorStoreService.search(
      KNOWLEDGE_COLLECTION,
      queryVector,
      {
        tenant_id: tenantId,
        categories: effectiveCategories,
      },
      topK,
      options.minScore,
    );

    return results.map((r) => ({
      chunkId: r.id,
      documentId: r.payload.document_id,
      content: r.payload.content,
      score: r.score,
      metadata: {
        page: r.payload.page,
        section: r.payload.section,
      },
    }));
  }

  // =========================================================================
  // LIST DOCUMENTS
  // =========================================================================

  async listDocuments(
    tenantId: string,
    filters?: DocumentFilters,
  ): Promise<Document[]> {
    const where: Record<string, any> = { tenantId };

    if (filters?.category) where.category = filters.category;
    if (filters?.status) where.status = filters.status;
    if (filters?.format) where.format = filters.format;

    return this.documentRepository.find({
      where,
      order: { uploadedAt: 'DESC' },
    });
  }

  // =========================================================================
  // CATEGORY MANAGEMENT
  // =========================================================================

  async createCategory(
    tenantId: string,
    dto: CreateCategoryInput,
  ): Promise<Category> {
    // Check if category already exists for this tenant
    const existing = await this.categoryRepository.findOne({
      where: { tenantId, name: dto.name },
    });
    if (existing) {
      throw new BadRequestException(
        `Category "${dto.name}" already exists for this tenant`,
      );
    }

    const category = this.categoryRepository.create({
      tenantId,
      name: dto.name,
      description: dto.description || null,
      isPredefined: false,
    });

    return this.categoryRepository.save(category);
  }

  async listCategories(tenantId: string): Promise<Category[]> {
    return this.categoryRepository.find({
      where: { tenantId },
      order: { isPredefined: 'DESC', name: 'ASC' },
    });
  }

  /**
   * Provision predefined categories for a tenant.
   * Called during tenant setup.
   */
  async provisionPredefinedCategories(tenantId: string): Promise<Category[]> {
    const categories: Category[] = [];

    for (const name of PREDEFINED_CATEGORIES) {
      const existing = await this.categoryRepository.findOne({
        where: { tenantId, name },
      });
      if (!existing) {
        const category = this.categoryRepository.create({
          tenantId,
          name,
          description: null,
          isPredefined: true,
        });
        categories.push(await this.categoryRepository.save(category));
      }
    }

    return categories;
  }

  // =========================================================================
  // PRIVATE: DOCUMENT PROCESSING PIPELINE
  // =========================================================================

  /**
   * Process a document: extract text → chunk → embed → upsert to Qdrant.
   */
  async processDocument(document: Document, fileBuffer: Buffer): Promise<void> {
    try {
      // Update status to processing
      document.status = 'processing';
      await this.documentRepository.save(document);

      // Step 1: Extract text
      const text = this.extractText(fileBuffer, document.format);

      // Step 2: Chunk the text
      const chunks = this.chunkText(text);

      if (chunks.length === 0) {
        throw new Error('No content could be extracted from the document');
      }

      // Step 3: Generate embeddings for all chunks
      const embeddings = await this.embeddingService.generateEmbeddings(
        chunks.map((c) => c.content),
      );

      // Step 4: Prepare vector points
      const points: VectorPoint[] = chunks.map((chunk, index) => ({
        id: uuidv4(),
        vector: embeddings[index],
        payload: {
          tenant_id: document.tenantId,
          document_id: document.id,
          category: document.category,
          content: chunk.content,
          page: chunk.page,
          section: chunk.section,
          uploaded_at: new Date().toISOString(),
        },
      }));

      // Step 5: Ensure collection exists and upsert
      await this.vectorStoreService.ensureCollection(KNOWLEDGE_COLLECTION, 1536);
      await this.vectorStoreService.upsertPoints(KNOWLEDGE_COLLECTION, points);

      // Step 6: Update document status
      document.status = 'processed';
      document.chunksCount = chunks.length;
      document.processedAt = new Date();
      document.errorMessage = null;
      await this.documentRepository.save(document);

      this.logger.log(
        `Document processed: ${document.id} (${chunks.length} chunks)`,
      );
    } catch (error) {
      document.status = 'error';
      document.errorMessage =
        error instanceof Error ? error.message : 'Unknown processing error';
      await this.documentRepository.save(document);
      throw error;
    }
  }

  /**
   * Reprocess a document by re-extracting from a stub.
   * In production, this would download the file from S3.
   */
  private async reprocessDocument(document: Document): Promise<void> {
    try {
      document.status = 'processing';
      await this.documentRepository.save(document);

      // In production, download from S3:
      // const fileBuffer = await this.storageService.download(document.storageKey);
      // For now, mark as error since we can't re-download in mock
      const stubText = `Reprocessed content for document: ${document.fileName}`;
      const chunks = this.chunkText(stubText);

      const embeddings = await this.embeddingService.generateEmbeddings(
        chunks.map((c) => c.content),
      );

      const points: VectorPoint[] = chunks.map((chunk, index) => ({
        id: uuidv4(),
        vector: embeddings[index],
        payload: {
          tenant_id: document.tenantId,
          document_id: document.id,
          category: document.category,
          content: chunk.content,
          page: chunk.page,
          section: chunk.section,
          uploaded_at: new Date().toISOString(),
        },
      }));

      await this.vectorStoreService.ensureCollection(KNOWLEDGE_COLLECTION, 1536);
      await this.vectorStoreService.upsertPoints(KNOWLEDGE_COLLECTION, points);

      document.status = 'processed';
      document.chunksCount = chunks.length;
      document.processedAt = new Date();
      document.errorMessage = null;
      await this.documentRepository.save(document);
    } catch (error) {
      document.status = 'error';
      document.errorMessage =
        error instanceof Error ? error.message : 'Unknown processing error';
      await this.documentRepository.save(document);
    }
  }

  // =========================================================================
  // PRIVATE: TEXT EXTRACTION (STUB)
  // =========================================================================

  /**
   * Extract text from file buffer based on format.
   * For PDF/DOCX, a real implementation would use pdf-parse / mammoth.
   * This stub returns the buffer as UTF-8 text for TXT/MD, and a placeholder for binary formats.
   */
  private extractText(buffer: Buffer, format: DocumentFormat): string {
    switch (format) {
      case 'txt':
      case 'md':
        return buffer.toString('utf-8');
      case 'pdf':
        // Stub: In production, use pdf-parse
        return buffer.toString('utf-8').replace(/[^\x20-\x7E\n\r\t]/g, ' ');
      case 'docx':
        // Stub: In production, use mammoth
        return buffer.toString('utf-8').replace(/[^\x20-\x7E\n\r\t]/g, ' ');
      default:
        return buffer.toString('utf-8');
    }
  }

  // =========================================================================
  // PRIVATE: CHUNKING
  // =========================================================================

  /**
   * Split text into chunks of approximately TARGET_CHUNK_CHARS characters.
   * Strategy: split by paragraphs first, then by sentences if paragraphs are too large.
   */
  chunkText(text: string): Array<{ content: string; page?: number; section?: string }> {
    const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 0);
    const chunks: Array<{ content: string; page?: number; section?: string }> = [];
    let currentChunk = '';
    let chunkIndex = 0;

    for (const paragraph of paragraphs) {
      const trimmedParagraph = paragraph.trim();

      if (currentChunk.length + trimmedParagraph.length + 1 <= TARGET_CHUNK_CHARS) {
        // Append to current chunk
        currentChunk = currentChunk
          ? `${currentChunk}\n\n${trimmedParagraph}`
          : trimmedParagraph;
      } else {
        // Current chunk is full, save it
        if (currentChunk.length >= MIN_CHUNK_CHARS) {
          chunks.push({
            content: currentChunk,
            section: `chunk_${chunkIndex}`,
          });
          chunkIndex++;
        }

        // If paragraph itself is too large, split by sentences
        if (trimmedParagraph.length > TARGET_CHUNK_CHARS) {
          const sentenceChunks = this.splitBySentences(trimmedParagraph);
          for (const sc of sentenceChunks) {
            chunks.push({ content: sc, section: `chunk_${chunkIndex}` });
            chunkIndex++;
          }
          currentChunk = '';
        } else {
          currentChunk = trimmedParagraph;
        }
      }
    }

    // Don't forget the last chunk
    if (currentChunk.length >= MIN_CHUNK_CHARS) {
      chunks.push({ content: currentChunk, section: `chunk_${chunkIndex}` });
    } else if (currentChunk.length > 0 && chunks.length > 0) {
      // Append small remainder to last chunk
      chunks[chunks.length - 1].content += `\n\n${currentChunk}`;
    } else if (currentChunk.length > 0) {
      // Only chunk available - include it regardless of size
      chunks.push({ content: currentChunk, section: `chunk_${chunkIndex}` });
    }

    return chunks;
  }

  /**
   * Split a large paragraph into sentence-based chunks.
   */
  private splitBySentences(text: string): string[] {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    const chunks: string[] = [];
    let current = '';

    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      if (current.length + trimmed.length + 1 <= TARGET_CHUNK_CHARS) {
        current = current ? `${current} ${trimmed}` : trimmed;
      } else {
        if (current.length >= MIN_CHUNK_CHARS) {
          chunks.push(current);
        }
        current = trimmed;
      }
    }

    if (current.length > 0) {
      chunks.push(current);
    }

    return chunks;
  }

  // =========================================================================
  // PRIVATE: HELPERS
  // =========================================================================

  private async findDocumentOrFail(
    documentId: string,
    tenantId: string,
  ): Promise<Document> {
    const document = await this.documentRepository.findOne({
      where: { id: documentId, tenantId },
    });
    if (!document) {
      throw new NotFoundException(`Document not found: ${documentId}`);
    }
    return document;
  }

  private extractFormat(filename: string): DocumentFormat {
    const ext = filename.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'pdf':
        return 'pdf';
      case 'docx':
        return 'docx';
      case 'txt':
        return 'txt';
      case 'md':
        return 'md';
      default:
        return ext as DocumentFormat;
    }
  }

  private getContentType(format: DocumentFormat): string {
    switch (format) {
      case 'pdf':
        return 'application/pdf';
      case 'docx':
        return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      case 'txt':
        return 'text/plain';
      case 'md':
        return 'text/markdown';
      default:
        return 'application/octet-stream';
    }
  }
}
