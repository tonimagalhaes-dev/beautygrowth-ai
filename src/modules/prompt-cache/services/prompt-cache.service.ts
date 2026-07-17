import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';

import { PromptCacheEntry } from '../entities/prompt-cache-entry.entity';
import { PromptFingerprintService } from './prompt-fingerprint.service';
import {
  CacheLookupResult,
  PaginatedCacheEntries,
  CacheEntryPreview,
  CacheEntryDetailResponse,
} from '../interfaces/prompt-cache.interface';
import { GenerateBriefingDto } from '../../content-agent/dto/generate-briefing.dto';
import { ContentAgentResponse } from '../../content-agent/dto/content-agent-response.dto';

/**
 * PromptCacheService handles cache lookups, persistence,
 * similar match detection, and image association for cache entries.
 *
 * The cache layer is non-blocking — failures in cache read/write
 * never prevent content generation from completing.
 *
 * Requirements: 1.1, 1.2, 2.2, 2.3, 2.4, 3.1, 3.3, 3.4
 */
@Injectable()
export class PromptCacheService {
  private readonly logger = new Logger(PromptCacheService.name);

  constructor(
    @InjectRepository(PromptCacheEntry)
    private readonly repository: Repository<PromptCacheEntry>,
    private readonly fingerprintService: PromptFingerprintService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Checks for a cached response matching the given prompt parameters.
   *
   * 1. Computes fingerprint and checks for exact match
   * 2. Falls back to similar match via pg_trgm similarity
   * 3. Returns 'miss' if no match found
   *
   * Cache failures are non-blocking: logs warning and returns 'miss'.
   */
  async checkCacheOrGenerate(
    dto: GenerateBriefingDto,
    tenantId: string,
    userId: string,
  ): Promise<CacheLookupResult> {
    try {
      const fingerprint = this.fingerprintService.computeFingerprint(dto);
      const normalizedTema = this.fingerprintService.getNormalizedTema(dto.tema);

      // 1. Check exact match
      const exactMatch = await this.repository.findOne({
        where: { tenantId, fingerprint },
      });

      if (exactMatch) {
        await this.incrementHitCount(exactMatch.id);
        return {
          type: 'exact_match',
          entry: exactMatch,
          source: 'cache',
          tokensConsumed: { input: 0, output: 0 },
        };
      }

      // 2. Check similar match
      const similarMatch = await this.findSimilarMatch(
        tenantId,
        normalizedTema,
        dto.redesSociais,
        dto.idioma ?? 'pt-BR',
        dto.procedimento ?? null,
      );

      if (similarMatch) {
        return {
          type: 'similar_match',
          entry: similarMatch,
          source: 'cache',
          confirmationRequired: true,
        };
      }

      // 3. No match
      return { type: 'miss' };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(
        `Cache lookup failed, proceeding as miss: ${err.message}`,
        err.stack,
      );
      return { type: 'miss' };
    }
  }

  /**
   * Persists a new cache entry after successful content generation.
   *
   * Cache write failures are non-blocking: logs error and returns undefined.
   */
  async persistCacheEntry(
    dto: GenerateBriefingDto,
    response: ContentAgentResponse,
    tenantId: string,
    userId: string,
  ): Promise<PromptCacheEntry | undefined> {
    try {
      const fingerprint = this.fingerprintService.computeFingerprint(dto);
      const normalizedTema = this.fingerprintService.getNormalizedTema(dto.tema);

      const entry = this.repository.create({
        tenantId,
        userId,
        executionId: response.executionId,
        tema: dto.tema,
        procedimento: dto.procedimento ?? null,
        publicoAlvoOverride: dto.publicoAlvoOverride ?? null,
        redesSociais: dto.redesSociais,
        idioma: dto.idioma ?? 'pt-BR',
        fingerprint,
        normalizedTema,
        responsePayload: response as unknown as Record<string, any>,
        tokensConsumedInput: response.tokensConsumidos.input,
        tokensConsumedOutput: response.tokensConsumidos.output,
        modeloUtilizado: response.modeloUtilizado,
      });

      return await this.repository.save(entry);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Failed to persist cache entry: ${err.message}`,
        err.stack,
      );
      return undefined;
    }
  }

  /**
   * Associates image references from the DesignerAgent with a cache entry.
   *
   * Cache write failures are non-blocking: logs error silently.
   */
  async associateImages(
    executionId: string,
    tenantId: string,
    images: Array<{ imageId: string; url: string; redeSocial: string }>,
  ): Promise<void> {
    try {
      await this.repository.update(
        { executionId, tenantId },
        { imageReferences: images },
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Failed to associate images with cache entry for execution ${executionId}: ${err.message}`,
        err.stack,
      );
    }
  }

  /**
   * Finds a similar match using PostgreSQL pg_trgm similarity on normalized_tema.
   * Matches must share the same redesSociais, idioma, and procedimento.
   * The similarity threshold is configurable via PROMPT_CACHE_SIMILARITY_THRESHOLD env var.
   */
  async findSimilarMatch(
    tenantId: string,
    normalizedTema: string,
    redesSociais: string[],
    idioma: string,
    procedimento: string | null,
  ): Promise<PromptCacheEntry | null> {
    const threshold = this.configService.get<number>(
      'PROMPT_CACHE_SIMILARITY_THRESHOLD',
      0.6,
    );

    const queryBuilder = this.repository
      .createQueryBuilder('cache')
      .where('cache.tenant_id = :tenantId', { tenantId })
      .andWhere('cache.redes_sociais = :redesSociais', {
        redesSociais: [...redesSociais].sort(),
      })
      .andWhere('cache.idioma = :idioma', { idioma })
      .andWhere(
        procedimento
          ? 'cache.procedimento = :procedimento'
          : 'cache.procedimento IS NULL',
        procedimento ? { procedimento } : {},
      )
      .andWhere('similarity(cache.normalized_tema, :tema) > :threshold', {
        tema: normalizedTema,
        threshold,
      })
      .orderBy('similarity(cache.normalized_tema, :tema)', 'DESC')
      .limit(1);

    const result = await queryBuilder.getOne();
    return result ?? null;
  }

  /**
   * Increments the hit count for a cache entry on cache hits.
   */
  async incrementHitCount(entryId: string): Promise<void> {
    try {
      await this.repository.increment({ id: entryId }, 'hitCount', 1);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(
        `Failed to increment hit count for entry ${entryId}: ${err.message}`,
      );
    }
  }

  /**
   * Returns a paginated list of cache entries for a given tenant,
   * ordered by creation date descending (most recent first).
   *
   * Requirements: 4.1, 4.2, 4.4
   */
  async listEntries(
    tenantId: string,
    page: number,
    limit: number,
  ): Promise<PaginatedCacheEntries> {
    const offset = (page - 1) * limit;

    const [entries, total] = await this.repository.findAndCount({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      skip: offset,
      take: limit,
    });

    const data: CacheEntryPreview[] = entries.map((entry) =>
      this.mapToPreview(entry),
    );

    return {
      data,
      page,
      limit,
      total,
      hasMore: offset + entries.length < total,
    };
  }

  /**
   * Returns the full detail of a single cache entry for a given tenant.
   * Throws NotFoundException if not found.
   *
   * Requirements: 4.2
   */
  async getEntry(
    tenantId: string,
    id: string,
  ): Promise<CacheEntryDetailResponse> {
    const entry = await this.repository.findOne({
      where: { id, tenantId },
    });

    if (!entry) {
      throw new NotFoundException(
        `Cache entry with id ${id} not found for this tenant`,
      );
    }

    return this.mapToDetail(entry);
  }

  /**
   * Maps a PromptCacheEntry to a CacheEntryPreview.
   * Extracts the first 120 characters from the first legenda in responsePayload.
   */
  private mapToPreview(entry: PromptCacheEntry): CacheEntryPreview {
    const payload = entry.responsePayload as unknown as ContentAgentResponse;
    let contentPreview = '';

    if (payload?.legendas) {
      const firstLegenda = Object.values(payload.legendas)[0];
      if (firstLegenda) {
        contentPreview = firstLegenda.substring(0, 120);
      }
    }

    return {
      id: entry.id,
      tema: entry.tema,
      redesSociais: entry.redesSociais,
      createdAt: entry.createdAt.toISOString(),
      contentPreview,
      hasImages: entry.imageReferences.length > 0,
    };
  }

  /**
   * Maps a PromptCacheEntry to a full CacheEntryDetailResponse.
   */
  private mapToDetail(entry: PromptCacheEntry): CacheEntryDetailResponse {
    return {
      id: entry.id,
      executionId: entry.executionId,
      tema: entry.tema,
      procedimento: entry.procedimento,
      publicoAlvoOverride: entry.publicoAlvoOverride,
      redesSociais: entry.redesSociais,
      idioma: entry.idioma,
      responsePayload: entry.responsePayload as unknown as ContentAgentResponse,
      imageReferences: entry.imageReferences,
      createdAt: entry.createdAt.toISOString(),
    };
  }
}
