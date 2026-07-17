import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';

import { PromptCacheController } from './prompt-cache.controller';
import { PromptCacheService } from '../services/prompt-cache.service';
import { ConfirmSimilarMatchDto } from '../dto/confirm-similar-match.dto';
import { TenantContext } from '@shared/interfaces';
import { TenantGuard } from '@shared/guards/tenant.guard';
import {
  PaginatedCacheEntries,
  CacheEntryDetailResponse,
} from '../interfaces/prompt-cache.interface';

describe('PromptCacheController', () => {
  let controller: PromptCacheController;
  let service: jest.Mocked<PromptCacheService>;

  const mockTenant: TenantContext = {
    tenantId: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222',
    role: 'admin',
  };

  const mockEntryId = '33333333-3333-3333-3333-333333333333';

  const mockPaginatedEntries: PaginatedCacheEntries = {
    data: [
      {
        id: mockEntryId,
        tema: 'Promoção de verão',
        redesSociais: ['instagram'],
        createdAt: '2024-01-01T10:00:00.000Z',
        contentPreview: 'Preview do conteúdo...',
        hasImages: false,
      },
    ],
    page: 1,
    limit: 20,
    total: 1,
    hasMore: false,
  };

  const mockEntryDetail: CacheEntryDetailResponse = {
    id: mockEntryId,
    executionId: '44444444-4444-4444-4444-444444444444',
    tema: 'Promoção de verão',
    procedimento: null,
    publicoAlvoOverride: null,
    redesSociais: ['instagram'],
    idioma: 'pt-BR',
    responsePayload: {
      executionId: '44444444-4444-4444-4444-444444444444',
      status: 'draft',
      version: 1,
      legendas: { instagram: 'Legenda IG', facebook: 'Legenda FB', tiktok: 'Legenda TT' },
      hashtags: ['#beleza'],
      sugestoesVisuais: {
        instagram: { formato: '1:1', descricao: 'Foto' },
        facebook: { formato: '1.91:1', descricao: 'Banner' },
        tiktok: { formato: '9:16', descricao: 'Video' },
      },
      modeloUtilizado: 'gpt-4o',
      usouFallback: false,
      tokensConsumidos: { input: 100, output: 200 },
      duracaoMs: 1500,
    },
    imageReferences: [],
    createdAt: '2024-01-01T10:00:00.000Z',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PromptCacheController],
      providers: [
        {
          provide: PromptCacheService,
          useValue: {
            listEntries: jest.fn(),
            getEntry: jest.fn(),
            incrementHitCount: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(TenantGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<PromptCacheController>(PromptCacheController);
    service = module.get(PromptCacheService);
  });

  describe('listEntries', () => {
    it('should return paginated cache entries for the tenant', async () => {
      service.listEntries.mockResolvedValue(mockPaginatedEntries);

      const result = await controller.listEntries(mockTenant, 1, 20);

      expect(service.listEntries).toHaveBeenCalledWith(
        mockTenant.tenantId,
        1,
        20,
      );
      expect(result).toEqual(mockPaginatedEntries);
    });

    it('should pass custom page and limit values', async () => {
      service.listEntries.mockResolvedValue({
        ...mockPaginatedEntries,
        page: 3,
        limit: 10,
      });

      const result = await controller.listEntries(mockTenant, 3, 10);

      expect(service.listEntries).toHaveBeenCalledWith(
        mockTenant.tenantId,
        3,
        10,
      );
      expect(result.page).toBe(3);
      expect(result.limit).toBe(10);
    });

    it('should return empty data when no entries exist', async () => {
      const emptyResult: PaginatedCacheEntries = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        hasMore: false,
      };
      service.listEntries.mockResolvedValue(emptyResult);

      const result = await controller.listEntries(mockTenant, 1, 20);

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe('getEntry', () => {
    it('should return full cache entry details', async () => {
      service.getEntry.mockResolvedValue(mockEntryDetail);

      const result = await controller.getEntry(mockTenant, mockEntryId);

      expect(service.getEntry).toHaveBeenCalledWith(
        mockTenant.tenantId,
        mockEntryId,
      );
      expect(result).toEqual(mockEntryDetail);
    });

    it('should propagate NotFoundException when entry not found', async () => {
      service.getEntry.mockRejectedValue(
        new NotFoundException('Cache entry not found'),
      );

      await expect(
        controller.getEntry(mockTenant, 'nonexistent-id'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should scope the request by tenant', async () => {
      service.getEntry.mockResolvedValue(mockEntryDetail);

      await controller.getEntry(mockTenant, mockEntryId);

      expect(service.getEntry).toHaveBeenCalledWith(
        mockTenant.tenantId,
        mockEntryId,
      );
    });
  });

  describe('confirmSimilarMatch', () => {
    it('should return cached response with source "cache" when confirmed', async () => {
      const dto: ConfirmSimilarMatchDto = {
        cacheEntryId: mockEntryId,
        confirmed: true,
      };
      service.getEntry.mockResolvedValue(mockEntryDetail);
      service.incrementHitCount.mockResolvedValue(undefined);

      const result = await controller.confirmSimilarMatch(mockTenant, dto);

      expect(service.getEntry).toHaveBeenCalledWith(
        mockTenant.tenantId,
        mockEntryId,
      );
      expect(service.incrementHitCount).toHaveBeenCalledWith(mockEntryId);
      expect(result.source).toBe('cache');
      expect(result.cacheEntryId).toBe(mockEntryId);
      // Should include the response payload fields
      expect(result.executionId).toBe(
        mockEntryDetail.responsePayload.executionId,
      );
      expect(result.legendas).toEqual(mockEntryDetail.responsePayload.legendas);
    });

    it('should return response with source "generated" and confirmationRequired false when declined', async () => {
      const dto: ConfirmSimilarMatchDto = {
        cacheEntryId: mockEntryId,
        confirmed: false,
      };

      const result = await controller.confirmSimilarMatch(mockTenant, dto);

      expect(service.getEntry).not.toHaveBeenCalled();
      expect(service.incrementHitCount).not.toHaveBeenCalled();
      expect(result.source).toBe('generated');
      expect(result.confirmationRequired).toBe(false);
      expect(result.cacheEntryId).toBe(mockEntryId);
    });

    it('should propagate NotFoundException when confirmed entry does not exist', async () => {
      const dto: ConfirmSimilarMatchDto = {
        cacheEntryId: 'nonexistent-id',
        confirmed: true,
      };
      service.getEntry.mockRejectedValue(
        new NotFoundException('Cache entry not found'),
      );

      await expect(
        controller.confirmSimilarMatch(mockTenant, dto),
      ).rejects.toThrow(NotFoundException);
    });

    it('should increment hit count when user confirms similar match', async () => {
      const dto: ConfirmSimilarMatchDto = {
        cacheEntryId: mockEntryId,
        confirmed: true,
      };
      service.getEntry.mockResolvedValue(mockEntryDetail);
      service.incrementHitCount.mockResolvedValue(undefined);

      await controller.confirmSimilarMatch(mockTenant, dto);

      expect(service.incrementHitCount).toHaveBeenCalledWith(mockEntryId);
    });

    it('should spread all response payload fields when confirmed', async () => {
      const dto: ConfirmSimilarMatchDto = {
        cacheEntryId: mockEntryId,
        confirmed: true,
      };
      service.getEntry.mockResolvedValue(mockEntryDetail);
      service.incrementHitCount.mockResolvedValue(undefined);

      const result = await controller.confirmSimilarMatch(mockTenant, dto);

      expect(result.status).toBe('draft');
      expect(result.hashtags).toEqual(['#beleza']);
      expect(result.modeloUtilizado).toBe('gpt-4o');
      expect(result.tokensConsumidos).toEqual({ input: 100, output: 200 });
    });
  });
});
