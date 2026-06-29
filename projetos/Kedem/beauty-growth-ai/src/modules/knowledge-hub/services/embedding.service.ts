import { Injectable, Logger } from '@nestjs/common';
import { IEmbeddingService, EMBEDDING_DIMENSION } from '../interfaces/embedding.interface';

/**
 * Mock embedding service that generates deterministic pseudo-random vectors.
 * In production, this would call OpenAI's text-embedding-ada-002 or similar.
 *
 * The mock uses a simple hash-based approach to generate consistent vectors
 * for the same input text, enabling meaningful testing.
 */
@Injectable()
export class MockEmbeddingService implements IEmbeddingService {
  private readonly logger = new Logger(MockEmbeddingService.name);

  async generateEmbedding(text: string): Promise<number[]> {
    this.logger.debug(`Generating mock embedding for text (${text.length} chars)`);
    return this.hashToVector(text);
  }

  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    this.logger.debug(`Generating ${texts.length} mock embeddings`);
    return texts.map((text) => this.hashToVector(text));
  }

  /**
   * Generate a deterministic vector from text using a simple hash.
   * Same text always produces the same vector.
   */
  private hashToVector(text: string): number[] {
    const vector: number[] = new Array(EMBEDDING_DIMENSION);
    let seed = 0;

    // Simple hash seed from text
    for (let i = 0; i < text.length; i++) {
      seed = ((seed << 5) - seed + text.charCodeAt(i)) | 0;
    }

    // Generate pseudo-random vector components from seed
    for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      vector[i] = (seed / 0x7fffffff) * 2 - 1; // normalize to [-1, 1]
    }

    // Normalize to unit vector (cosine similarity requires this)
    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
      vector[i] = vector[i] / magnitude;
    }

    return vector;
  }
}
