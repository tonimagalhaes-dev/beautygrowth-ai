/**
 * Interface for the vector store (Qdrant).
 * Abstracts the Qdrant client operations for testability.
 */
export interface VectorPointPayload {
  tenant_id: string;
  document_id: string;
  category: string;
  content: string;
  page?: number;
  section?: string;
  uploaded_at: string;
}

export interface VectorPoint {
  id: string;
  vector: number[];
  payload: VectorPointPayload;
}

export interface VectorSearchFilter {
  tenant_id: string;
  categories?: string[];
}

export interface VectorSearchResult {
  id: string;
  score: number;
  payload: VectorPointPayload;
}

export interface IVectorStoreService {
  /**
   * Upsert points (chunks) into the vector store.
   */
  upsertPoints(collectionName: string, points: VectorPoint[]): Promise<void>;

  /**
   * Search for similar vectors with payload filtering.
   */
  search(
    collectionName: string,
    vector: number[],
    filter: VectorSearchFilter,
    topK: number,
    minScore?: number,
  ): Promise<VectorSearchResult[]>;

  /**
   * Delete all points matching the given document_id filter.
   */
  deleteByDocumentId(collectionName: string, documentId: string): Promise<void>;

  /**
   * Ensure the collection exists, creating it if necessary.
   */
  ensureCollection(collectionName: string, vectorSize: number): Promise<void>;
}

export const VECTOR_STORE_SERVICE = Symbol('VECTOR_STORE_SERVICE');

/** Collection name for knowledge hub chunks */
export const KNOWLEDGE_COLLECTION = 'knowledge_chunks';
