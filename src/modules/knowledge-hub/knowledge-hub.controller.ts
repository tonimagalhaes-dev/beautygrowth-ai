import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { KnowledgeHubService } from './services/knowledge-hub.service';
import { UploadDocumentDto, SearchDocumentsDto, CreateCategoryDto } from './dto';
import { Document } from './entities/document.entity';
import { Category } from './entities/category.entity';
import { SearchResult, DocumentFilters } from './interfaces/knowledge-hub.interface';
import { CurrentTenant } from '@shared/decorators';
import { TenantContext } from '@shared/interfaces';

@Controller('knowledge-hub')
export class KnowledgeHubController {
  constructor(private readonly knowledgeHubService: KnowledgeHubService) {}

  /**
   * POST /knowledge-hub/documents
   * Upload a document to the knowledge hub.
   */
  @Post('documents')
  @UseInterceptors(FileInterceptor('file'))
  async uploadDocument(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<Document> {
    return this.knowledgeHubService.upload(
      tenant.tenantId,
      file,
      { category: dto.category, description: dto.description },
      tenant.userId,
    );
  }

  /**
   * GET /knowledge-hub/documents
   * List documents for the current tenant with optional filters.
   */
  @Get('documents')
  async listDocuments(
    @CurrentTenant() tenant: TenantContext,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('format') format?: string,
  ): Promise<Document[]> {
    const filters: DocumentFilters = {};
    if (category) filters.category = category;
    if (status) filters.status = status;
    if (format) filters.format = format;

    return this.knowledgeHubService.listDocuments(tenant.tenantId, filters);
  }

  /**
   * DELETE /knowledge-hub/documents/:id
   * Delete a document and all its chunks from the system.
   */
  @Delete('documents/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<void> {
    return this.knowledgeHubService.delete(id, tenant.tenantId);
  }

  /**
   * POST /knowledge-hub/documents/:id/reprocess
   * Reprocess a document (re-extract, re-chunk, re-embed).
   */
  @Post('documents/:id/reprocess')
  async reprocessDocument(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<Document> {
    return this.knowledgeHubService.reprocess(id, tenant.tenantId);
  }

  /**
   * POST /knowledge-hub/search
   * Semantic search across the tenant's knowledge base.
   */
  @Post('search')
  async search(
    @Body() dto: SearchDocumentsDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<SearchResult[]> {
    return this.knowledgeHubService.search(tenant.tenantId, dto.query, {
      topK: dto.topK || 5,
      categories: dto.categories,
      minScore: dto.minScore,
    });
  }

  /**
   * POST /knowledge-hub/search/agent/:agentId
   * Semantic search restricted to the agent's authorized categories.
   */
  @Post('search/agent/:agentId')
  async searchForAgent(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() dto: SearchDocumentsDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<SearchResult[]> {
    // In a full implementation, we'd look up the agent's knowledgeCategories
    // from agent-config. For now, categories from the DTO serve as authorized.
    return this.knowledgeHubService.search(
      tenant.tenantId,
      dto.query,
      {
        topK: dto.topK || 5,
        categories: dto.categories,
        minScore: dto.minScore,
      },
      dto.categories, // agent authorized categories
    );
  }

  /**
   * POST /knowledge-hub/categories
   * Create a custom category.
   */
  @Post('categories')
  async createCategory(
    @Body() dto: CreateCategoryDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<Category> {
    return this.knowledgeHubService.createCategory(tenant.tenantId, {
      name: dto.name,
      description: dto.description,
    });
  }

  /**
   * GET /knowledge-hub/categories
   * List all categories for the current tenant.
   */
  @Get('categories')
  async listCategories(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<Category[]> {
    return this.knowledgeHubService.listCategories(tenant.tenantId);
  }
}
