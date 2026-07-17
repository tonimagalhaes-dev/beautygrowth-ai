import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentTenant } from '@shared/decorators';
import { TenantContext } from '@shared/interfaces';
import { TenantGuard } from '@shared/guards/tenant.guard';
import { PromptCacheService } from '../services/prompt-cache.service';
import { ConfirmSimilarMatchDto } from '../dto/confirm-similar-match.dto';
import {
  PaginatedCacheEntries,
  CacheEntryDetailResponse,
  ContentAgentResponseWithMeta,
} from '../interfaces/prompt-cache.interface';

/**
 * PromptCacheController exposes REST endpoints for the cache history panel
 * and similar match confirmation flow.
 *
 * All endpoints are tenant-scoped via TenantGuard.
 *
 * Requirements: 3.2, 3.3, 3.4, 4.1, 4.4
 */
@Controller('prompt-cache')
@UseGuards(TenantGuard)
export class PromptCacheController {
  constructor(private readonly promptCacheService: PromptCacheService) {}

  /**
   * GET /api/prompt-cache/entries
   * Returns paginated list of cache entries for the tenant.
   * Query params: page (default 1), limit (default 20)
   */
  @Get('entries')
  async listEntries(
    @CurrentTenant() tenant: TenantContext,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ): Promise<PaginatedCacheEntries> {
    return this.promptCacheService.listEntries(tenant.tenantId, page, limit);
  }

  /**
   * GET /api/prompt-cache/entries/:id
   * Returns full cache entry details including response payload.
   */
  @Get('entries/:id')
  async getEntry(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CacheEntryDetailResponse> {
    return this.promptCacheService.getEntry(tenant.tenantId, id);
  }

  /**
   * POST /api/prompt-cache/confirm-similar
   * User confirms or declines use of a similar match.
   * Body: { cacheEntryId: string, confirmed: boolean }
   *
   * If confirmed === true: returns the cached entry's response with source: 'cache'
   * If confirmed === false: returns a response indicating frontend should proceed with new generation
   */
  @Post('confirm-similar')
  @HttpCode(HttpStatus.OK)
  async confirmSimilarMatch(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: ConfirmSimilarMatchDto,
  ): Promise<ContentAgentResponseWithMeta> {
    if (dto.confirmed) {
      // User accepted the similar match — return the cached response
      const entry = await this.promptCacheService.getEntry(
        tenant.tenantId,
        dto.cacheEntryId,
      );

      // Increment hit count since user confirmed usage
      await this.promptCacheService.incrementHitCount(dto.cacheEntryId);

      return {
        ...entry.responsePayload,
        source: 'cache',
        cacheEntryId: dto.cacheEntryId,
      };
    }

    // User declined — signal frontend to proceed with a new generation
    // Cast is needed because the declined response is a signal to the frontend,
    // not a real content response (empty fields indicate "proceed with generation")
    return {
      executionId: '',
      status: 'draft',
      version: 0,
      legendas: {} as Record<string, string>,
      hashtags: [],
      sugestoesVisuais: {} as Record<string, { formato: string; descricao: string }>,
      modeloUtilizado: '',
      usouFallback: false,
      tokensConsumidos: { input: 0, output: 0 },
      duracaoMs: 0,
      source: 'generated',
      confirmationRequired: false,
      cacheEntryId: dto.cacheEntryId,
    } as ContentAgentResponseWithMeta;
  }
}
