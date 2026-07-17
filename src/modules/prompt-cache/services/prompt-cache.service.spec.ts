import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';

import { PromptCacheService } from './prompt-cache.service';
import { PromptFingerprintService } from './prompt-fingerprint.service';
import { PromptCacheEntry } from '../entities/prompt-cache-entry.entity';
import { GenerateBriefingDto } from '../../content-agent/dto/generate-briefing.dto';
import { ContentAgentResponse } from '../../content-agent/dto/content-agent-response.dto';

describe('PromptCacheService', () => {
  let service: PromptCacheService;
  let repository: jest.Mocked<Repository<PromptCacheEntry>>;
  let fingerprintService: jest.Mocked<PromptFingerprintService>;
  let configService: jest.Mocked<ConfigService>;

  const mockTenantId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '22222222-2222-2222-2222-222222222222';
  const mockFingerprint = 'abc123def456abc123def456abc123def456abc123def456abc123def456abcd';

  const validDto: GenerateBriefingDto = {
    tema: 'Promoção de verão para tratamento facial',
    redesSociais: ['instagram', 'facebook'],
    idioma: 'pt-BR',
  };

  const mockCacheEntry: Partial<PromptCacheEntry> = {
    id: '33333333-3333-3333-3333-333333333333',
    tenantId: mockTenantId,
    userId: mockUserId,
    executionId: '44444444-4444-4444-4444-444444444444',
    tema: 'Promoção de verão para tratamento facial',
    procedimento: null,
    publicoAlvoOverride: null,
    redesSociais: ['instagram', 'facebook'],
    idioma: 'pt-BR',
    fingerprint: mockFingerprint,
    normalizedTema: 'promoção de verão para tratamento facial',
    responsePayload: {
      executionId: '44444444-4444-4444-4444-444444444444',
      status: 'draft',
      legendas: { instagram: 'Legenda IG', facebook: 'Legenda FB', tiktok: 'Legenda TikTok' },
      hashtags: ['#beleza'],
      sugestoesVisuais: {},
      modeloUtilizado: 'gpt-4o',
      usouFallback: false,
      tokensConsumidos: { input: 100, output: 200 },
      duracaoMs: 1500,
    },
    imageReferences: [],
    tokensConsumedInput: 100,
    tokensConsumedOutput: 200,
    modeloUtilizado: 'gpt-4o',
    hitCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockContentAgentResponse: ContentAgentResponse = {
    executionId: '44444444-4444-4444-4444-444444444444',
    status: 'draft',
    version: 1,
    legendas: { instagram: 'Legenda IG', facebook: 'Legenda FB', tiktok: 'Legenda TikTok' },
    hashtags: ['#beleza'],
    sugestoesVisuais: {
      instagram: { formato: '1:1', descricao: 'Foto' },
      facebook: { formato: '1.91:1', descricao: 'Banner' },
      tiktok: { formato: '9:16', descricao: 'Video vertical' },
    },
    modeloUtilizado: 'gpt-4o',
    usouFallback: false,
    tokensConsumidos: { input: 100, output: 200 },
    duracaoMs: 1500,
  };

  // Mock query builder
  let mockQueryBuilder: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    getOne: jest.Mock;
  };

  beforeEach(async () => {
    mockQueryBuilder = {
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      limit: jest.fn(),
      getOne: jest.fn().mockResolvedValue(null),
    };
    // Make query builder methods chainable
    mockQueryBuilder.where.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.andWhere.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.orderBy.mockReturnValue(mockQueryBuilder);
    mockQueryBuilder.limit.mockReturnValue(mockQueryBuilder);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromptCacheService,
        {
          provide: getRepositoryToken(PromptCacheEntry),
          useValue: {
            findOne: jest.fn(),
            findAndCount: jest.fn(),
            increment: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            update: jest.fn(),
            createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
          },
        },
        {
          provide: PromptFingerprintService,
          useValue: {
            computeFingerprint: jest.fn().mockReturnValue(mockFingerprint),
            getNormalizedTema: jest.fn().mockReturnValue('promoção de verão para tratamento facial'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue(0.6),
          },
        },
      ],
    }).compile();

    service = module.get<PromptCacheService>(PromptCacheService);
    repository = module.get(getRepositoryToken(PromptCacheEntry));
    fingerprintService = module.get(PromptFingerprintService);
    configService = module.get(ConfigService);
  });

  describe('checkCacheOrGenerate', () => {
    it('should return exact_match when fingerprint matches', async () => {
      repository.findOne.mockResolvedValue(mockCacheEntry as PromptCacheEntry);

      const result = await service.checkCacheOrGenerate(validDto, mockTenantId, mockUserId);

      expect(result.type).toBe('exact_match');
      expect(result.entry).toBe(mockCacheEntry);
      expect(result.source).toBe('cache');
      expect(result.tokensConsumed).toEqual({ input: 0, output: 0 });
    });

    it('should increment hit count on exact match', async () => {
      repository.findOne.mockResolvedValue(mockCacheEntry as PromptCacheEntry);

      await service.checkCacheOrGenerate(validDto, mockTenantId, mockUserId);

      expect(repository.increment).toHaveBeenCalledWith(
        { id: mockCacheEntry.id },
        'hitCount',
        1,
      );
    });

    it('should return similar_match when no exact match but similar found', async () => {
      repository.findOne.mockResolvedValue(null);
      mockQueryBuilder.getOne.mockResolvedValue(mockCacheEntry as PromptCacheEntry);

      const result = await service.checkCacheOrGenerate(validDto, mockTenantId, mockUserId);

      expect(result.type).toBe('similar_match');
      expect(result.entry).toBe(mockCacheEntry);
      expect(result.source).toBe('cache');
      expect(result.confirmationRequired).toBe(true);
    });

    it('should return miss when no exact or similar match found', async () => {
      repository.findOne.mockResolvedValue(null);
      mockQueryBuilder.getOne.mockResolvedValue(null);

      const result = await service.checkCacheOrGenerate(validDto, mockTenantId, mockUserId);

      expect(result.type).toBe('miss');
      expect(result.entry).toBeUndefined();
    });

    it('should compute fingerprint using PromptFingerprintService', async () => {
      repository.findOne.mockResolvedValue(null);

      await service.checkCacheOrGenerate(validDto, mockTenantId, mockUserId);

      expect(fingerprintService.computeFingerprint).toHaveBeenCalledWith(validDto);
    });

    it('should search by tenantId and fingerprint for exact match', async () => {
      repository.findOne.mockResolvedValue(null);

      await service.checkCacheOrGenerate(validDto, mockTenantId, mockUserId);

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { tenantId: mockTenantId, fingerprint: mockFingerprint },
      });
    });

    it('should return miss and log warning on repository error (non-blocking)', async () => {
      repository.findOne.mockRejectedValue(new Error('Database connection lost'));

      const result = await service.checkCacheOrGenerate(validDto, mockTenantId, mockUserId);

      expect(result.type).toBe('miss');
    });

    it('should not throw when increment hit count fails', async () => {
      repository.findOne.mockResolvedValue(mockCacheEntry as PromptCacheEntry);
      repository.increment.mockRejectedValue(new Error('DB error'));

      // incrementHitCount has its own try/catch, but checkCacheOrGenerate wraps
      // the whole thing in a try/catch too
      const result = await service.checkCacheOrGenerate(validDto, mockTenantId, mockUserId);

      // It should still return the match (increment failure is non-blocking)
      expect(result.type).toBe('exact_match');
    });
  });

  describe('persistCacheEntry', () => {
    it('should create and save a new cache entry', async () => {
      const createdEntry = { ...mockCacheEntry } as PromptCacheEntry;
      repository.create.mockReturnValue(createdEntry);
      repository.save.mockResolvedValue(createdEntry);

      const result = await service.persistCacheEntry(
        validDto,
        mockContentAgentResponse,
        mockTenantId,
        mockUserId,
      );

      expect(result).toBe(createdEntry);
      expect(repository.create).toHaveBeenCalledWith({
        tenantId: mockTenantId,
        userId: mockUserId,
        executionId: mockContentAgentResponse.executionId,
        tema: validDto.tema,
        procedimento: null,
        publicoAlvoOverride: null,
        redesSociais: validDto.redesSociais,
        idioma: 'pt-BR',
        fingerprint: mockFingerprint,
        normalizedTema: 'promoção de verão para tratamento facial',
        responsePayload: mockContentAgentResponse as unknown as Record<string, any>,
        tokensConsumedInput: 100,
        tokensConsumedOutput: 200,
        modeloUtilizado: 'gpt-4o',
      });
      expect(repository.save).toHaveBeenCalledWith(createdEntry);
    });

    it('should return undefined and not throw on save failure (non-blocking)', async () => {
      repository.create.mockReturnValue({} as PromptCacheEntry);
      repository.save.mockRejectedValue(new Error('Unique constraint violation'));

      const result = await service.persistCacheEntry(
        validDto,
        mockContentAgentResponse,
        mockTenantId,
        mockUserId,
      );

      expect(result).toBeUndefined();
    });

    it('should use procedimento from dto when provided', async () => {
      const dtoWithProcedimento: GenerateBriefingDto = {
        ...validDto,
        procedimento: '55555555-5555-5555-5555-555555555555',
      };
      repository.create.mockReturnValue({} as PromptCacheEntry);
      repository.save.mockResolvedValue({} as PromptCacheEntry);

      await service.persistCacheEntry(
        dtoWithProcedimento,
        mockContentAgentResponse,
        mockTenantId,
        mockUserId,
      );

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          procedimento: '55555555-5555-5555-5555-555555555555',
        }),
      );
    });
  });

  describe('associateImages', () => {
    const executionId = '44444444-4444-4444-4444-444444444444';
    const images = [
      { imageId: 'img-1', url: 'https://example.com/img1.png', redeSocial: 'instagram' },
      { imageId: 'img-2', url: 'https://example.com/img2.png', redeSocial: 'facebook' },
    ];

    it('should update cache entry with image references', async () => {
      repository.update.mockResolvedValue({ affected: 1, raw: [], generatedMaps: [] });

      await service.associateImages(executionId, mockTenantId, images);

      expect(repository.update).toHaveBeenCalledWith(
        { executionId, tenantId: mockTenantId },
        { imageReferences: images },
      );
    });

    it('should not throw on update failure (non-blocking)', async () => {
      repository.update.mockRejectedValue(new Error('DB error'));

      await expect(
        service.associateImages(executionId, mockTenantId, images),
      ).resolves.toBeUndefined();
    });
  });

  describe('findSimilarMatch', () => {
    it('should use configurable threshold from ConfigService', async () => {
      configService.get.mockReturnValue(0.7);

      await service.findSimilarMatch(
        mockTenantId,
        'promoção de verão',
        ['instagram'],
        'pt-BR',
        null,
      );

      expect(configService.get).toHaveBeenCalledWith(
        'PROMPT_CACHE_SIMILARITY_THRESHOLD',
        0.6,
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'similarity(cache.normalized_tema, :tema) > :threshold',
        { tema: 'promoção de verão', threshold: 0.7 },
      );
    });

    it('should filter by tenantId, redesSociais, idioma, and null procedimento', async () => {
      await service.findSimilarMatch(
        mockTenantId,
        'promoção de verão',
        ['instagram', 'facebook'],
        'pt-BR',
        null,
      );

      expect(mockQueryBuilder.where).toHaveBeenCalledWith(
        'cache.tenant_id = :tenantId',
        { tenantId: mockTenantId },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'cache.redes_sociais = :redesSociais',
        { redesSociais: ['facebook', 'instagram'] },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'cache.idioma = :idioma',
        { idioma: 'pt-BR' },
      );
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'cache.procedimento IS NULL',
        {},
      );
    });

    it('should filter by procedimento when provided', async () => {
      const procedimentoId = '55555555-5555-5555-5555-555555555555';

      await service.findSimilarMatch(
        mockTenantId,
        'promoção de verão',
        ['instagram'],
        'pt-BR',
        procedimentoId,
      );

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'cache.procedimento = :procedimento',
        { procedimento: procedimentoId },
      );
    });

    it('should sort redesSociais for consistent comparison', async () => {
      await service.findSimilarMatch(
        mockTenantId,
        'promoção de verão',
        ['facebook', 'instagram'],
        'pt-BR',
        null,
      );

      expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
        'cache.redes_sociais = :redesSociais',
        { redesSociais: ['facebook', 'instagram'] },
      );
    });

    it('should order by similarity DESC and limit to 1', async () => {
      await service.findSimilarMatch(
        mockTenantId,
        'promoção de verão',
        ['instagram'],
        'pt-BR',
        null,
      );

      expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith(
        'similarity(cache.normalized_tema, :tema)',
        'DESC',
      );
      expect(mockQueryBuilder.limit).toHaveBeenCalledWith(1);
    });

    it('should return null when no similar match found', async () => {
      mockQueryBuilder.getOne.mockResolvedValue(null);

      const result = await service.findSimilarMatch(
        mockTenantId,
        'promoção de verão',
        ['instagram'],
        'pt-BR',
        null,
      );

      expect(result).toBeNull();
    });

    it('should return the most similar entry when found', async () => {
      mockQueryBuilder.getOne.mockResolvedValue(mockCacheEntry as PromptCacheEntry);

      const result = await service.findSimilarMatch(
        mockTenantId,
        'promoção de verão',
        ['instagram'],
        'pt-BR',
        null,
      );

      expect(result).toBe(mockCacheEntry);
    });
  });

  describe('incrementHitCount', () => {
    it('should increment hit count by 1', async () => {
      await service.incrementHitCount(mockCacheEntry.id!);

      expect(repository.increment).toHaveBeenCalledWith(
        { id: mockCacheEntry.id },
        'hitCount',
        1,
      );
    });

    it('should not throw on increment failure', async () => {
      repository.increment.mockRejectedValue(new Error('DB error'));

      await expect(
        service.incrementHitCount(mockCacheEntry.id!),
      ).resolves.toBeUndefined();
    });
  });

  describe('listEntries', () => {
    const mockEntries: Partial<PromptCacheEntry>[] = [
      {
        ...mockCacheEntry,
        id: 'entry-1',
        tema: 'Tratamento facial',
        createdAt: new Date('2024-01-03T10:00:00Z'),
        imageReferences: [
          { imageId: 'img-1', url: 'https://example.com/img1.png', redeSocial: 'instagram' },
        ],
      },
      {
        ...mockCacheEntry,
        id: 'entry-2',
        tema: 'Promoção de natal',
        createdAt: new Date('2024-01-02T10:00:00Z'),
        imageReferences: [],
      },
      {
        ...mockCacheEntry,
        id: 'entry-3',
        tema: 'Dica de skincare',
        createdAt: new Date('2024-01-01T10:00:00Z'),
        imageReferences: [],
      },
    ];

    it('should return paginated entries ordered by createdAt DESC', async () => {
      repository.findAndCount.mockResolvedValue([
        mockEntries as PromptCacheEntry[],
        3,
      ]);

      const result = await service.listEntries(mockTenantId, 1, 20);

      expect(repository.findAndCount).toHaveBeenCalledWith({
        where: { tenantId: mockTenantId },
        order: { createdAt: 'DESC' },
        skip: 0,
        take: 20,
      });
      expect(result.total).toBe(3);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.hasMore).toBe(false);
      expect(result.data).toHaveLength(3);
    });

    it('should calculate correct offset for page > 1', async () => {
      repository.findAndCount.mockResolvedValue([[], 0]);

      await service.listEntries(mockTenantId, 3, 10);

      expect(repository.findAndCount).toHaveBeenCalledWith({
        where: { tenantId: mockTenantId },
        order: { createdAt: 'DESC' },
        skip: 20,
        take: 10,
      });
    });

    it('should set hasMore=true when more entries exist', async () => {
      repository.findAndCount.mockResolvedValue([
        mockEntries.slice(0, 2) as PromptCacheEntry[],
        5,
      ]);

      const result = await service.listEntries(mockTenantId, 1, 2);

      expect(result.hasMore).toBe(true);
      expect(result.total).toBe(5);
      expect(result.data).toHaveLength(2);
    });

    it('should set hasMore=false when on last page', async () => {
      repository.findAndCount.mockResolvedValue([
        mockEntries.slice(2) as PromptCacheEntry[],
        3,
      ]);

      const result = await service.listEntries(mockTenantId, 2, 2);

      expect(result.hasMore).toBe(false);
    });

    it('should map entries to CacheEntryPreview with contentPreview from first legenda', async () => {
      repository.findAndCount.mockResolvedValue([
        [mockEntries[0]] as PromptCacheEntry[],
        1,
      ]);

      const result = await service.listEntries(mockTenantId, 1, 20);

      expect(result.data[0]).toEqual({
        id: 'entry-1',
        tema: 'Tratamento facial',
        redesSociais: ['instagram', 'facebook'],
        createdAt: '2024-01-03T10:00:00.000Z',
        contentPreview: 'Legenda IG',
        hasImages: true,
      });
    });

    it('should set hasImages=false when imageReferences is empty', async () => {
      repository.findAndCount.mockResolvedValue([
        [mockEntries[1]] as PromptCacheEntry[],
        1,
      ]);

      const result = await service.listEntries(mockTenantId, 1, 20);

      expect(result.data[0].hasImages).toBe(false);
    });

    it('should truncate contentPreview to 120 characters', async () => {
      const longLegenda = 'A'.repeat(200);
      const entryWithLongLegenda: Partial<PromptCacheEntry> = {
        ...mockCacheEntry,
        id: 'entry-long',
        createdAt: new Date('2024-01-01T10:00:00Z'),
        responsePayload: {
          ...mockCacheEntry.responsePayload,
          legendas: { instagram: longLegenda },
        } as unknown as Record<string, any>,
      };

      repository.findAndCount.mockResolvedValue([
        [entryWithLongLegenda] as PromptCacheEntry[],
        1,
      ]);

      const result = await service.listEntries(mockTenantId, 1, 20);

      expect(result.data[0].contentPreview).toHaveLength(120);
    });

    it('should handle entries with empty responsePayload.legendas gracefully', async () => {
      const entryNoLegendas: Partial<PromptCacheEntry> = {
        ...mockCacheEntry,
        id: 'entry-no-legendas',
        createdAt: new Date('2024-01-01T10:00:00Z'),
        responsePayload: { legendas: {} } as unknown as Record<string, any>,
      };

      repository.findAndCount.mockResolvedValue([
        [entryNoLegendas] as PromptCacheEntry[],
        1,
      ]);

      const result = await service.listEntries(mockTenantId, 1, 20);

      expect(result.data[0].contentPreview).toBe('');
    });

    it('should return empty data array when no entries exist', async () => {
      repository.findAndCount.mockResolvedValue([[], 0]);

      const result = await service.listEntries(mockTenantId, 1, 20);

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.hasMore).toBe(false);
    });
  });

  describe('getEntry', () => {
    it('should return full CacheEntryDetailResponse for existing entry', async () => {
      repository.findOne.mockResolvedValue(mockCacheEntry as PromptCacheEntry);

      const result = await service.getEntry(mockTenantId, mockCacheEntry.id!);

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: mockCacheEntry.id, tenantId: mockTenantId },
      });
      expect(result).toEqual({
        id: mockCacheEntry.id,
        executionId: mockCacheEntry.executionId,
        tema: mockCacheEntry.tema,
        procedimento: mockCacheEntry.procedimento,
        publicoAlvoOverride: mockCacheEntry.publicoAlvoOverride,
        redesSociais: mockCacheEntry.redesSociais,
        idioma: mockCacheEntry.idioma,
        responsePayload: mockCacheEntry.responsePayload,
        imageReferences: mockCacheEntry.imageReferences,
        createdAt: mockCacheEntry.createdAt!.toISOString(),
      });
    });

    it('should throw NotFoundException when entry does not exist', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.getEntry(mockTenantId, 'nonexistent-id'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should scope query by both tenantId and id', async () => {
      repository.findOne.mockResolvedValue(mockCacheEntry as PromptCacheEntry);

      await service.getEntry(mockTenantId, mockCacheEntry.id!);

      expect(repository.findOne).toHaveBeenCalledWith({
        where: { id: mockCacheEntry.id, tenantId: mockTenantId },
      });
    });

    it('should include imageReferences in the response', async () => {
      const entryWithImages: Partial<PromptCacheEntry> = {
        ...mockCacheEntry,
        imageReferences: [
          { imageId: 'img-1', url: 'https://example.com/img1.png', redeSocial: 'instagram' },
        ],
      };
      repository.findOne.mockResolvedValue(entryWithImages as PromptCacheEntry);

      const result = await service.getEntry(mockTenantId, mockCacheEntry.id!);

      expect(result.imageReferences).toEqual([
        { imageId: 'img-1', url: 'https://example.com/img1.png', redeSocial: 'instagram' },
      ]);
    });
  });
});
