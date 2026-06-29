import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { KnowledgeHubController } from './knowledge-hub.controller';
import { KnowledgeHubService } from './services/knowledge-hub.service';
import { MockEmbeddingService } from './services/embedding.service';
import { MockVectorStoreService } from './services/vector-store.service';
import { QdrantVectorStoreService } from './services/qdrant-vector-store.service';
import { StorageService } from '../brand/services/storage.service';
import { Document } from './entities/document.entity';
import { Category } from './entities/category.entity';
import { EMBEDDING_SERVICE } from './interfaces/embedding.interface';
import { VECTOR_STORE_SERVICE } from './interfaces/vector-store.interface';
import { STORAGE_SERVICE } from '../brand/interfaces/brand.interface';

@Module({
  imports: [
    TypeOrmModule.forFeature([Document, Category]),
    ConfigModule,
  ],
  controllers: [KnowledgeHubController],
  providers: [
    KnowledgeHubService,
    {
      provide: EMBEDDING_SERVICE,
      useClass: MockEmbeddingService,
    },
    {
      provide: VECTOR_STORE_SERVICE,
      useFactory: (configService: ConfigService) => {
        const useQdrant = configService.get<string>('QDRANT_HOST');
        if (useQdrant) {
          const service = new QdrantVectorStoreService(configService);
          return service;
        }
        return new MockVectorStoreService();
      },
      inject: [ConfigService],
    },
    {
      provide: STORAGE_SERVICE,
      useClass: StorageService,
    },
  ],
  exports: [KnowledgeHubService, VECTOR_STORE_SERVICE, EMBEDDING_SERVICE],
})
export class KnowledgeHubModule {}
