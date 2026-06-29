import { Injectable, Logger } from '@nestjs/common';
import {
  IVectorStoreService,
  VectorPoint,
  VectorSearchFilter,
  VectorSearchResult,
} from '../interfaces/vector-store.interface';

/**
 * In-memory mock implementation of the vector store (Qdrant).
 * In production, this would connect to a real Qdrant instance via @qdrant/js-client-rest.
 *
 * This mock stores points in memory and performs cosine similarity search,
 * enabling full pipeline testing without an external Qdrant dependency.
 */
@Injectable()
export class MockVectorStoreService implements IVectorStoreService {
  private readonly logger = new Logger(MockVectorStoreService.name);
  private readonly collections: Map<string, VectorPoint[]> = new Map();

  async ensureCollection(collectionName: string, _vectorSize: number): Promise<void> {
    if (!this.collections.has(collectionName)) {
      this.collections.set(collectionName, []);
      this.logger.log(`Created collection: ${collectionName}`);
    }
  }

  async upsertPoints(collectionName: string, points: VectorPoint[]): Promise<void> {
    const collection = this.getOrCreateCollection(collectionName);

    for (const point of points) {
      const existingIndex = collection.findIndex((p) => p.id === point.id);
      if (existingIndex >= 0) {
        collection[existingIndex] = point;
      } else {
        collection.push(point);
      }
    }

    this.logger.debug(
      `Upserted ${points.length} points in ${collectionName} (total: ${collection.length})`,
    );
  }

  async search(
    collectionName: string,
    vector: number[],
    filter: VectorSearchFilter,
    topK: number,
    minScore?: number,
  ): Promise<VectorSearchResult[]> {
    const collection = this.collections.get(collectionName) || [];

    // Filter points by tenant and categories
    const filtered = collection.filter((point) => {
      if (point.payload.tenant_id !== filter.tenant_id) return false;
      if (
        filter.categories &&
        filter.categories.length > 0 &&
        !filter.categories.includes(point.payload.category)
      ) {
        return false;
      }
      return true;
    });

    // Calculate cosine similarity for each point
    const scored = filtered.map((point) => ({
      id: point.id,
      score: this.cosineSimilarity(vector, point.vector),
      payload: point.payload,
    }));

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Apply min score filter
    const results = minScore
      ? scored.filter((r) => r.score >= minScore)
      : scored;

    return results.slice(0, topK);
  }

  async deleteByDocumentId(collectionName: string, documentId: string): Promise<void> {
    const collection = this.collections.get(collectionName);
    if (!collection) return;

    const before = collection.length;
    const filtered = collection.filter(
      (point) => point.payload.document_id !== documentId,
    );
    this.collections.set(collectionName, filtered);

    this.logger.debug(
      `Deleted ${before - filtered.length} points for document ${documentId}`,
    );
  }

  /**
   * Get all points in a collection (for testing).
   */
  getPoints(collectionName: string): VectorPoint[] {
    return this.collections.get(collectionName) || [];
  }

  /**
   * Clear all collections (for testing).
   */
  clear(): void {
    this.collections.clear();
  }

  private getOrCreateCollection(name: string): VectorPoint[] {
    if (!this.collections.has(name)) {
      this.collections.set(name, []);
    }
    return this.collections.get(name)!;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator === 0) return 0;

    return dotProduct / denominator;
  }
}
