/**
 * Interface for the embedding service.
 * In production, this will call an external embedding model (e.g., OpenAI ada-002).
 * For now, a mock implementation is used that generates random vectors of the correct dimension.
 */
export interface IEmbeddingService {
  /**
   * Generate an embedding vector for the given text.
   * @param text - The text to embed
   * @returns A float array of size 1536 (matching Qdrant collection config)
   */
  generateEmbedding(text: string): Promise<number[]>;

  /**
   * Generate embeddings for multiple texts in batch.
   * @param texts - Array of texts to embed
   * @returns Array of float arrays of size 1536
   */
  generateEmbeddings(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_SERVICE = Symbol('EMBEDDING_SERVICE');

/** Vector dimension for the embedding model (OpenAI text-embedding-ada-002) */
export const EMBEDDING_DIMENSION = 1536;
