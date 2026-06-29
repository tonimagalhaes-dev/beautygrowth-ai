import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QdrantClient } from '@qdrant/js-client-rest';

import {
  IVectorStoreService,
  VectorPoint,
  VectorSearchFilter,
  VectorSearchResult,
} from '../interfaces/vector-store.interface';

/**
 * Production Qdrant vector store service using @qdrant/js-client-rest.
 * Connects to a real Qdrant instance and handles:
 * - Collection creation with proper vector config (1536 dims, cosine distance)
 * - Point upserts with payload filtering for multi-tenant isolation
 * - Semantic search with tenant_id and category payload filters
 * - Document deletion by payload filter
 */
@Injectable()
export class QdrantVectorStoreService implements IVectorStoreService, OnModuleInit {
  private readonly logger = new Logger(QdrantVectorStoreService.name);
  private client: QdrantClient;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const host = this.configService.get<string>('QDRANT_HOST', 'localhost');
    const port = this.configService.get<number>('QDRANT_PORT', 6333);
    const apiKey = this.configService.get<string>('QDRANT_API_KEY');

    this.client = new QdrantClient({
      host,
      port,
      ...(apiKey ? { apiKey } : {}),
    });

    this.logger.log(`Connected to Qdrant at ${host}:${port}`);
  }

  async ensureCollection(collectionName: string, vectorSize: number): Promise<void> {
    try {
      const exists = await this.client.collectionExists(collectionName);

      if (!exists.exists) {
        await this.client.createCollection(collectionName, {
          vectors: {
            size: vectorSize,
            distance: 'Cosine',
          },
        });

        // Create payload indexes for efficient filtering
        await this.client.createPayloadIndex(collectionName, {
          field_name: 'tenant_id',
          field_schema: 'keyword',
        });
        await this.client.createPayloadIndex(collectionName, {
          field_name: 'document_id',
          field_schema: 'keyword',
        });
        await this.client.createPayloadIndex(collectionName, {
          field_name: 'category',
          field_schema: 'keyword',
        });

        this.logger.log(`Created collection: ${collectionName} (size=${vectorSize}, cosine)`);
      }
    } catch (error) {
      this.logger.error(`Failed to ensure collection ${collectionName}`, error);
      throw error;
    }
  }

  async upsertPoints(collectionName: string, points: VectorPoint[]): Promise<void> {
    if (points.length === 0) return;

    try {
      // Qdrant supports batch upserts
      await this.client.upsert(collectionName, {
        wait: true,
        points: points.map((p) => ({
          id: p.id,
          vector: p.vector,
          payload: p.payload as unknown as Record<string, unknown>,
        })),
      });

      this.logger.debug(
        `Upserted ${points.length} points in ${collectionName}`,
      );
    } catch (error) {
      this.logger.error(`Failed to upsert points in ${collectionName}`, error);
      throw error;
    }
  }

  async search(
    collectionName: string,
    vector: number[],
    filter: VectorSearchFilter,
    topK: number,
    minScore?: number,
  ): Promise<VectorSearchResult[]> {
    try {
      // Build the must conditions for filtering
      const mustConditions: Array<Record<string, unknown>> = [
        {
          key: 'tenant_id',
          match: { value: filter.tenant_id },
        },
      ];

      // Add category filter if specified
      if (filter.categories && filter.categories.length > 0) {
        mustConditions.push({
          key: 'category',
          match: { any: filter.categories },
        });
      }

      const results = await this.client.search(collectionName, {
        vector,
        limit: topK,
        score_threshold: minScore,
        filter: {
          must: mustConditions,
        },
        with_payload: true,
      });

      return results.map((r) => ({
        id: r.id as string,
        score: r.score,
        payload: r.payload as unknown as VectorSearchResult['payload'],
      }));
    } catch (error) {
      this.logger.error(`Search failed in ${collectionName}`, error);
      throw error;
    }
  }

  async deleteByDocumentId(collectionName: string, documentId: string): Promise<void> {
    try {
      await this.client.delete(collectionName, {
        wait: true,
        filter: {
          must: [
            {
              key: 'document_id',
              match: { value: documentId },
            },
          ],
        },
      });

      this.logger.debug(
        `Deleted points for document ${documentId} from ${collectionName}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to delete points for document ${documentId}`,
        error,
      );
      throw error;
    }
  }
}
