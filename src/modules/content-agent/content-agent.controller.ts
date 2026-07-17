import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ContentAgentService } from './services/content-agent.service';
import { GenerateBriefingDto } from './dto/generate-briefing.dto';
import { RefineBriefingDto } from './dto/refine-briefing.dto';
import { ContentAgentResponse } from './dto/content-agent-response.dto';
import { CurrentTenant } from '@shared/decorators';
import { TenantContext } from '@shared/interfaces';
import { TenantGuard } from '@shared/guards/tenant.guard';
import { PromptCacheService } from '../prompt-cache/services/prompt-cache.service';
import { ContentAgentResponseWithMeta } from '../prompt-cache/interfaces/prompt-cache.interface';

@Controller('content-agent')
@UseGuards(TenantGuard)
export class ContentAgentController {
  constructor(
    private readonly contentAgentService: ContentAgentService,
    private readonly promptCacheService: PromptCacheService,
  ) {}

  /**
   * POST /api/content-agent/generate
   * Generates content based on a briefing for the authenticated tenant.
   *
   * Integrates with the prompt cache layer:
   * - On exact match: returns cached response with source "cache" and zero tokens
   * - On similar match: returns cached response with confirmationRequired flag
   * - On miss: proceeds with AI generation, then persists result to cache
   *
   * Requirements: 2.2, 2.3, 2.4, 3.1, 7.1, 7.2
   */
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  async generate(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: GenerateBriefingDto,
  ): Promise<ContentAgentResponseWithMeta> {
    // 1. Check cache for exact or similar match
    const cacheResult = await this.promptCacheService.checkCacheOrGenerate(
      dto,
      tenant.tenantId,
      tenant.userId,
    );

    // 2. On exact match: return cached response immediately
    if (cacheResult.type === 'exact_match' && cacheResult.entry) {
      const cachedResponse =
        cacheResult.entry.responsePayload as unknown as ContentAgentResponse;
      return {
        ...cachedResponse,
        tokensConsumidos: { input: 0, output: 0 },
        source: 'cache',
      };
    }

    // 3. On similar match: return cached response with confirmation required
    if (cacheResult.type === 'similar_match' && cacheResult.entry) {
      const cachedResponse =
        cacheResult.entry.responsePayload as unknown as ContentAgentResponse;
      return {
        ...cachedResponse,
        tokensConsumidos: { input: 0, output: 0 },
        source: 'cache',
        confirmationRequired: true,
        cacheEntryId: cacheResult.entry.id,
      };
    }

    // 4. On miss: proceed with normal generation
    const response = await this.contentAgentService.generate(
      dto,
      tenant.tenantId,
      tenant.userId,
    );

    // 5. Persist successful generation to cache (non-blocking)
    if (response.status === 'draft') {
      this.promptCacheService.persistCacheEntry(
        dto,
        response,
        tenant.tenantId,
        tenant.userId,
      );
    }

    // 6. Return response with source metadata
    return {
      ...response,
      source: 'generated',
    };
  }

  /**
   * POST /api/content-agent/refine
   * Refines previously generated content for the authenticated tenant.
   * No caching for refinements — always invokes the Content_Agent.
   */
  @Post('refine')
  @HttpCode(HttpStatus.OK)
  async refine(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: RefineBriefingDto,
  ): Promise<ContentAgentResponse> {
    return this.contentAgentService.refine(
      dto,
      tenant.tenantId,
      tenant.userId,
    );
  }
}
