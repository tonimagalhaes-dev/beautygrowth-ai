import { Document } from '../entities/document.entity';
import { Category } from '../entities/category.entity';

export interface SearchOptions {
  topK: number; // 3-10, default 5
  categories?: string[]; // filter by category
  minScore?: number; // similarity threshold
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  content: string;
  score: number; // cosine similarity
  metadata: { page?: number; section?: string };
}

export interface DocumentFilters {
  category?: string;
  status?: string;
  format?: string;
}

export interface UploadDocInput {
  category: string;
  description?: string;
}

export interface CreateCategoryInput {
  name: string;
  description?: string;
}

export interface IKnowledgeHubService {
  upload(
    tenantId: string,
    file: Express.Multer.File,
    dto: UploadDocInput,
    uploadedBy: string,
  ): Promise<Document>;
  delete(documentId: string, tenantId: string): Promise<void>;
  reprocess(documentId: string, tenantId: string): Promise<Document>;
  search(
    tenantId: string,
    query: string,
    options: SearchOptions,
    authorizedCategories?: string[],
  ): Promise<SearchResult[]>;
  listDocuments(tenantId: string, filters?: DocumentFilters): Promise<Document[]>;
  createCategory(tenantId: string, dto: CreateCategoryInput): Promise<Category>;
  listCategories(tenantId: string): Promise<Category[]>;
}

export const KNOWLEDGE_HUB_SERVICE = Symbol('KNOWLEDGE_HUB_SERVICE');
