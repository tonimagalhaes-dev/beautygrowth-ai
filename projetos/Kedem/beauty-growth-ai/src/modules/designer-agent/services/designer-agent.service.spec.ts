import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { NotFoundException, HttpException, HttpStatus } from '@nestjs/common';

import { DesignerAgentService } from './designer-agent.service';
import { DesignerExecution } from '../entities/designer-execution.entity';
import { DesignerImage } from '../entities/designer-image.entity';
import { DesignerEditHistory } from '../entities/designer-edit-history.entity';
import { LangGraphClientService } from '../../agent-execution/services/langgraph-client.service';
import { CircuitBreakerService } from '../../agent-execution/services/circuit-breaker.service';
import { AgentMemoryService } from '../../agent-memory/services/agent-memory.service';
import { ObservabilityService } from '../../observability/services/observability.service';

// Mock @aws-sdk/s3-request-presigner
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://minio.example.com/presigned-url'),
}));

// Mock @aws-sdk/client-s3
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({})),
  GetObjectCommand: jest.fn().mockImplementation((params) => params),
}));

describe('DesignerAgentService', () => {
  let service: DesignerAgentService;
  let executionRepo: Record<string, jest.Mock>;
  let imageRepo: Record<string, jest.Mock>;
  let editHistoryRepo: Record<string, jest.Mock>;
  let circuitBreakerService: Record<string, jest.Mock>;

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const executionId = '22222222-2222-2222-2222-222222222222';
  const imageId = '33333333-3333-3333-3333-333333333333';

  const mockExecution: Partial<DesignerExecution> = {
    id: 'exec-pk-id',
    executionId,
    tenantId,
    userId: '44444444-4444-4444-4444-444444444444',
    contentExecutionId: null,
    status: 'generated',
    descricaoVisual: 'Uma imagem elegante de procedimento estético',
    redesSociais: ['instagram', 'facebook'],
    estiloVisualAdicional: null,
    aplicarLogoOverlay: false,
    logoOverlayAplicado: false,
    version: 1,
    modeloUtilizado: 'gemini-3.1-flash-image',
    usouFallback: false,
    tokensConsumidos: 1250,
    duracaoMs: 12500,
    guardrailViolations: [],
    warnings: [],
    brandIdentityDefaultsUsed: false,
    traceId: '55555555-5555-5555-5555-555555555555',
    createdAt: new Date('2025-01-10T10:00:00Z'),
    updatedAt: new Date('2025-01-10T10:00:12Z'),
    completedAt: new Date('2025-01-10T10:00:12Z'),
  };

  const futureDate = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000); // 5 days from now

  const mockImages: Partial<DesignerImage>[] = [
    {
      id: imageId,
      executionId,
      tenantId,
      redeSocial: 'instagram',
      aspectoRatio: '4:5',
      larguraPx: 1080,
      alturaPx: 1350,
      tamanhoBytes: 2048576,
      formato: 'PNG',
      minioPath: `${tenantId}/designer/${executionId}/instagram_20250110100010123.png`,
      minioPathThumbnail: `${tenantId}/designer/${executionId}/instagram_20250110100010123_thumb.jpg`,
      minioPathSemOverlay: null,
      urlPresigned: 'https://minio.example.com/original-presigned',
      urlPresignedThumbnail: 'https://minio.example.com/thumb-presigned',
      urlPresignedSemOverlay: null,
      urlPresignedExpiresAt: futureDate,
      modeloUtilizado: 'gemini-3.1-flash-image',
      version: 1,
      isLatest: true,
      createdAt: new Date('2025-01-10T10:00:10Z'),
    },
    {
      id: '66666666-6666-6666-6666-666666666666',
      executionId,
      tenantId,
      redeSocial: 'facebook',
      aspectoRatio: '1.91:1',
      larguraPx: 1200,
      alturaPx: 628,
      tamanhoBytes: 1536000,
      formato: 'PNG',
      minioPath: `${tenantId}/designer/${executionId}/facebook_20250110100010456.png`,
      minioPathThumbnail: `${tenantId}/designer/${executionId}/facebook_20250110100010456_thumb.jpg`,
      minioPathSemOverlay: null,
      urlPresigned: 'https://minio.example.com/fb-presigned',
      urlPresignedThumbnail: 'https://minio.example.com/fb-thumb-presigned',
      urlPresignedSemOverlay: null,
      urlPresignedExpiresAt: futureDate,
      modeloUtilizado: 'gemini-3.1-flash-image',
      version: 1,
      isLatest: true,
      createdAt: new Date('2025-01-10T10:00:10Z'),
    },
  ];

  beforeEach(async () => {
    executionRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      update: jest.fn(),
      save: jest.fn(),
    };

    imageRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn(),
    };

    editHistoryRepo = {
      count: jest.fn(),
      find: jest.fn(),
      save: jest.fn(),
    };

    circuitBreakerService = {
      execute: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DesignerAgentService,
        {
          provide: getRepositoryToken(DesignerExecution),
          useValue: executionRepo,
        },
        {
          provide: getRepositoryToken(DesignerImage),
          useValue: imageRepo,
        },
        {
          provide: getRepositoryToken(DesignerEditHistory),
          useValue: editHistoryRepo,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) => {
              const config: Record<string, string> = {
                S3_BUCKET: 'beauty-growth-ai',
                S3_ENDPOINT: 'http://localhost:9000',
                S3_REGION: 'us-east-1',
                S3_ACCESS_KEY_ID: 'minioadmin',
                S3_SECRET_ACCESS_KEY: 'minioadmin',
              };
              return config[key] || defaultValue;
            }),
          },
        },
        {
          provide: LangGraphClientService,
          useValue: { executeWorkflow: jest.fn() },
        },
        {
          provide: CircuitBreakerService,
          useValue: circuitBreakerService,
        },
        {
          provide: AgentMemoryService,
          useValue: { persistInteraction: jest.fn(), getShortTermMemory: jest.fn().mockResolvedValue([]) },
        },
        {
          provide: ObservabilityService,
          useValue: { logAgentAction: jest.fn(), generateTraceId: jest.fn().mockReturnValue('trace-mock-uuid') },
        },
      ],
    }).compile();

    service = module.get<DesignerAgentService>(DesignerAgentService);
  });

  describe('getExecution', () => {
    it('should return complete response with images when execution exists', async () => {
      executionRepo.findOne.mockResolvedValue(mockExecution);
      imageRepo.find.mockResolvedValue(mockImages);

      const result = await service.getExecution(executionId, tenantId);

      expect(result.executionId).toBe(executionId);
      expect(result.status).toBe('generated');
      expect(result.modeloUtilizado).toBe('gemini-3.1-flash-image');
      expect(result.usouFallback).toBe(false);
      expect(result.tokensConsumidos).toBe(1250);
      expect(result.duracaoMs).toBe(12500);
      expect(result.version).toBe(1);
      expect(result.logoOverlayAplicado).toBe(false);
      expect(result.warnings).toEqual([]);
      expect(result.contentExecutionId).toBeUndefined();

      // Verify images are mapped correctly
      expect(result.images.instagram).toBeDefined();
      expect(result.images.instagram.url).toBe('https://minio.example.com/original-presigned');
      expect(result.images.instagram.urlThumbnail).toBe('https://minio.example.com/thumb-presigned');
      expect(result.images.instagram.aspectoRatio).toBe('4:5');
      expect(result.images.instagram.tamanhoBytes).toBe(2048576);
      expect(result.images.instagram.status).toBe('generated');

      expect(result.images.facebook).toBeDefined();
      expect(result.images.facebook.url).toBe('https://minio.example.com/fb-presigned');
      expect(result.images.facebook.aspectoRatio).toBe('1.91:1');
    });

    it('should throw NotFoundException when execution does not exist', async () => {
      executionRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getExecution('nonexistent-id', tenantId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should include contentExecutionId when linked to Content Agent', async () => {
      const executionWithContent = {
        ...mockExecution,
        contentExecutionId: '77777777-7777-7777-7777-777777777777',
      };
      executionRepo.findOne.mockResolvedValue(executionWithContent);
      imageRepo.find.mockResolvedValue(mockImages);

      const result = await service.getExecution(executionId, tenantId);

      expect(result.contentExecutionId).toBe('77777777-7777-7777-7777-777777777777');
    });

    it('should regenerate presigned URLs when expired', async () => {
      const expiredDate = new Date(Date.now() - 1000); // expired
      const expiredImages = mockImages.map((img) => ({
        ...img,
        urlPresignedExpiresAt: expiredDate,
      }));

      executionRepo.findOne.mockResolvedValue(mockExecution);
      imageRepo.find.mockResolvedValue(expiredImages);

      const result = await service.getExecution(executionId, tenantId);

      // Should have called update on expired images
      expect(imageRepo.update).toHaveBeenCalledTimes(2);
      // URLs should be the newly generated ones
      expect(result.images.instagram.url).toBe('https://minio.example.com/presigned-url');
      expect(result.images.instagram.urlThumbnail).toBe('https://minio.example.com/presigned-url');
    });

    it('should regenerate presigned URLs when expiring within 1 day', async () => {
      const soonExpiring = new Date(Date.now() + 12 * 60 * 60 * 1000); // 12 hours from now
      const expiringImages = mockImages.map((img) => ({
        ...img,
        urlPresignedExpiresAt: soonExpiring,
      }));

      executionRepo.findOne.mockResolvedValue(mockExecution);
      imageRepo.find.mockResolvedValue(expiringImages);

      const result = await service.getExecution(executionId, tenantId);

      // Should regenerate because within 1-day threshold
      expect(imageRepo.update).toHaveBeenCalled();
      expect(result.images.instagram.url).toBe('https://minio.example.com/presigned-url');
    });

    it('should NOT regenerate presigned URLs when still valid (> 1 day)', async () => {
      executionRepo.findOne.mockResolvedValue(mockExecution);
      imageRepo.find.mockResolvedValue(mockImages); // futureDate is 5 days out

      const result = await service.getExecution(executionId, tenantId);

      // Should NOT update since URLs are still valid
      expect(imageRepo.update).not.toHaveBeenCalled();
      expect(result.images.instagram.url).toBe('https://minio.example.com/original-presigned');
    });

    it('should include urlSemOverlay when overlay was applied', async () => {
      const imagesWithOverlay = [
        {
          ...mockImages[0],
          minioPathSemOverlay: `${tenantId}/designer/${executionId}/instagram_20250110100010123_overlay.png`,
          urlPresignedSemOverlay: 'https://minio.example.com/no-overlay-presigned',
        },
      ];

      executionRepo.findOne.mockResolvedValue({
        ...mockExecution,
        logoOverlayAplicado: true,
      });
      imageRepo.find.mockResolvedValue(imagesWithOverlay);

      const result = await service.getExecution(executionId, tenantId);

      expect(result.logoOverlayAplicado).toBe(true);
      expect(result.images.instagram.urlSemOverlay).toBe(
        'https://minio.example.com/no-overlay-presigned',
      );
    });

    it('should return status processing with empty images when still generating', async () => {
      executionRepo.findOne.mockResolvedValue({
        ...mockExecution,
        status: 'processing',
        modeloUtilizado: null,
        duracaoMs: null,
        completedAt: null,
      });
      imageRepo.find.mockResolvedValue([]);

      const result = await service.getExecution(executionId, tenantId);

      expect(result.status).toBe('processing');
      expect(result.images).toEqual({});
      expect(result.modeloUtilizado).toBe('');
    });

    it('should query images with isLatest=true filter', async () => {
      executionRepo.findOne.mockResolvedValue(mockExecution);
      imageRepo.find.mockResolvedValue(mockImages);

      await service.getExecution(executionId, tenantId);

      expect(imageRepo.find).toHaveBeenCalledWith({
        where: { executionId, isLatest: true },
      });
    });
  });

  describe('getDownloadUrl', () => {
    it('should return existing presigned URL when still valid', async () => {
      imageRepo.findOne.mockResolvedValue({
        ...mockImages[0],
        urlPresignedExpiresAt: futureDate,
      });

      const url = await service.getDownloadUrl(executionId, imageId, tenantId);

      expect(url).toBe('https://minio.example.com/original-presigned');
      expect(imageRepo.update).not.toHaveBeenCalled();
    });

    it('should regenerate URL when expired', async () => {
      const expiredDate = new Date(Date.now() - 1000);
      imageRepo.findOne.mockResolvedValue({
        ...mockImages[0],
        urlPresignedExpiresAt: expiredDate,
      });

      const url = await service.getDownloadUrl(executionId, imageId, tenantId);

      expect(url).toBe('https://minio.example.com/presigned-url');
      expect(imageRepo.update).toHaveBeenCalledWith(
        { id: imageId },
        expect.objectContaining({
          urlPresigned: 'https://minio.example.com/presigned-url',
        }),
      );
    });

    it('should regenerate URL when urlPresignedExpiresAt is null', async () => {
      imageRepo.findOne.mockResolvedValue({
        ...mockImages[0],
        urlPresignedExpiresAt: null,
      });

      const url = await service.getDownloadUrl(executionId, imageId, tenantId);

      expect(url).toBe('https://minio.example.com/presigned-url');
      expect(imageRepo.update).toHaveBeenCalled();
    });

    it('should throw NotFoundException when image does not exist', async () => {
      imageRepo.findOne.mockResolvedValue(null);

      await expect(
        service.getDownloadUrl(executionId, 'nonexistent-id', tenantId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should query by both imageId and executionId for security', async () => {
      imageRepo.findOne.mockResolvedValue({
        ...mockImages[0],
        urlPresignedExpiresAt: futureDate,
      });

      await service.getDownloadUrl(executionId, imageId, tenantId);

      expect(imageRepo.findOne).toHaveBeenCalledWith({
        where: { id: imageId, executionId },
      });
    });
  });

  describe('edit', () => {
    const editDto = {
      executionId,
      redeSocial: 'instagram' as const,
      instrucaoEdicao: 'Aumentar destaque para o rosto da modelo',
    };

    const mockGrpcResponse = {
      success: true,
      output: JSON.stringify({
        status: 'generated',
        images: {
          instagram: {
            url: 'https://minio.example.com/edited-image.png',
            url_thumbnail: 'https://minio.example.com/edited-thumb.jpg',
            aspecto_ratio: '4:5',
            tamanho_bytes: 2200000,
            status: 'generated',
          },
        },
        version: 2,
        logo_overlay_aplicado: false,
        warnings: [],
      }),
      traceId: 'trace-123',
      modelId: 'gemini-3.1-flash-image',
      usedFallback: false,
      tokensUsed: { inputTokens: 500, outputTokens: 200 },
      durationMs: 8000,
      blockedReason: '',
      guardrailViolations: [],
      finalState: {} as any,
      steps: [],
    };

    it('should successfully edit an image when execution exists and edit limit not reached', async () => {
      executionRepo.findOne.mockResolvedValue(mockExecution);
      editHistoryRepo.count.mockResolvedValue(2);
      circuitBreakerService.execute.mockImplementation((fn) => fn());

      // Mock langGraphClient.executeWorkflow via the circuit breaker
      const langGraphClient = (service as any).langGraphClient;
      langGraphClient.executeWorkflow = jest.fn().mockResolvedValue(mockGrpcResponse);

      const result = await service.edit(editDto, tenantId, mockExecution.userId!);

      expect(result.executionId).toBe(executionId);
      expect(result.status).toBe('generated');
      expect(result.version).toBe(2);
      expect(result.images.instagram).toBeDefined();
      expect(result.images.instagram.url).toBe('https://minio.example.com/edited-image.png');
      expect(result.images.instagram.urlThumbnail).toBe('https://minio.example.com/edited-thumb.jpg');
      expect(result.modeloUtilizado).toBe('gemini-3.1-flash-image');
      expect(result.tokensConsumidos).toBe(700);
      expect(result.duracaoMs).toBe(8000);
    });

    it('should throw NotFoundException when execution does not exist', async () => {
      executionRepo.findOne.mockResolvedValue(null);

      await expect(
        service.edit(editDto, tenantId, '44444444-4444-4444-4444-444444444444'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when execution belongs to another tenant', async () => {
      executionRepo.findOne.mockResolvedValue(null); // query with tenantId filter returns null

      await expect(
        service.edit(editDto, 'other-tenant-id', '44444444-4444-4444-4444-444444444444'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw 429 when edit limit (5) is reached', async () => {
      executionRepo.findOne.mockResolvedValue(mockExecution);
      editHistoryRepo.count.mockResolvedValue(5);

      await expect(
        service.edit(editDto, tenantId, mockExecution.userId!),
      ).rejects.toThrow(HttpException);

      try {
        await service.edit(editDto, tenantId, mockExecution.userId!);
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        expect((error as HttpException).message).toContain('instagram');
      }
    });

    it('should throw 429 when edit count exceeds limit', async () => {
      executionRepo.findOne.mockResolvedValue(mockExecution);
      editHistoryRepo.count.mockResolvedValue(7); // exceeds 5

      await expect(
        service.edit(editDto, tenantId, mockExecution.userId!),
      ).rejects.toThrow(HttpException);
    });

    it('should count edits from designer_edit_history table for the specific rede_social', async () => {
      executionRepo.findOne.mockResolvedValue(mockExecution);
      editHistoryRepo.count.mockResolvedValue(0);
      circuitBreakerService.execute.mockImplementation((fn) => fn());

      const langGraphClient = (service as any).langGraphClient;
      langGraphClient.executeWorkflow = jest.fn().mockResolvedValue(mockGrpcResponse);

      await service.edit(editDto, tenantId, mockExecution.userId!);

      expect(editHistoryRepo.count).toHaveBeenCalledWith({
        where: {
          executionId: editDto.executionId,
          redeSocial: editDto.redeSocial,
        },
      });
    });

    it('should pass is_edit metadata to gRPC request', async () => {
      executionRepo.findOne.mockResolvedValue(mockExecution);
      editHistoryRepo.count.mockResolvedValue(0);

      const langGraphClient = (service as any).langGraphClient;
      langGraphClient.executeWorkflow = jest.fn().mockResolvedValue(mockGrpcResponse);

      circuitBreakerService.execute.mockImplementation((fn) => fn());

      await service.edit(editDto, tenantId, mockExecution.userId!);

      expect(langGraphClient.executeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'designer-agent',
          tenantId,
          userInput: editDto.instrucaoEdicao,
          options: expect.objectContaining({
            metadata: expect.objectContaining({
              is_edit: 'true',
              original_execution_id: editDto.executionId,
              target_social: editDto.redeSocial,
              edit_instruction: editDto.instrucaoEdicao,
            }),
          }),
        }),
      );
    });

    it('should throw 503 when circuit breaker fallback is triggered', async () => {
      executionRepo.findOne.mockResolvedValue(mockExecution);
      editHistoryRepo.count.mockResolvedValue(0);

      circuitBreakerService.execute.mockImplementation((_fn, fallback) => fallback());

      await expect(
        service.edit(editDto, tenantId, mockExecution.userId!),
      ).rejects.toThrow(HttpException);

      try {
        circuitBreakerService.execute.mockImplementation((_fn, fallback) => fallback());
        await service.edit(editDto, tenantId, mockExecution.userId!);
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      }
    });
  });

  describe('fromContent', () => {
    const contentExecutionId = '88888888-8888-8888-8888-888888888888';
    const fromContentDto = {
      contentExecutionId,
      aplicarLogoOverlay: false,
      estiloVisualAdicional: 'foto realista',
    };

    const mockContentMemory = [
      {
        id: 'mem-1',
        agentId: 'content',
        tenantId,
        role: 'assistant' as const,
        content: JSON.stringify({
          status: 'draft',
          sugestoes_visuais: {
            instagram: { formato: '4:5', descricao: 'Imagem elegante de harmonização facial com tons pastéis' },
            facebook: { formato: '1.91:1', descricao: 'Banner profissional para clínica de estética' },
          },
          redes_sociais: ['instagram', 'facebook'],
        }),
        timestamp: new Date(),
        metadata: { execution_id: contentExecutionId, version: 1, status: 'draft' },
      },
    ];

    let agentMemoryService: { persistInteraction: jest.Mock; getShortTermMemory: jest.Mock };
    let observabilityService: { logAgentAction: jest.Mock; generateTraceId: jest.Mock };

    beforeEach(() => {
      agentMemoryService = (service as any).agentMemoryService;
      observabilityService = (service as any).observabilityService;
      observabilityService.generateTraceId = jest.fn().mockReturnValue('trace-test-123');
      executionRepo.save = jest.fn().mockResolvedValue({});
      executionRepo.create = jest.fn().mockImplementation((data) => data);
      executionRepo.update = jest.fn().mockResolvedValue({ affected: 1 });
    });

    it('should return 202 with executionId and status processing when Content Agent execution is valid (draft)', async () => {
      agentMemoryService.getShortTermMemory.mockResolvedValue(mockContentMemory);
      circuitBreakerService.execute.mockResolvedValue({});

      const result = await service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444');

      expect(result.status).toBe('processing');
      expect(result.executionId).toBeDefined();
      expect(typeof result.executionId).toBe('string');
      // Verify execution was persisted
      expect(executionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          contentExecutionId,
          status: 'processing',
          redesSociais: expect.arrayContaining(['instagram', 'facebook']),
          aplicarLogoOverlay: false,
          estiloVisualAdicional: 'foto realista',
        }),
      );
      expect(executionRepo.save).toHaveBeenCalled();
    });

    it('should return 202 when Content Agent execution status is approved', async () => {
      const approvedMemory = [
        {
          ...mockContentMemory[0],
          content: JSON.stringify({
            status: 'approved',
            sugestoes_visuais: {
              instagram: { formato: '4:5', descricao: 'Imagem elegante' },
            },
            redes_sociais: ['instagram'],
          }),
          metadata: { execution_id: contentExecutionId, version: 1, status: 'approved' },
        },
      ];
      agentMemoryService.getShortTermMemory.mockResolvedValue(approvedMemory);
      circuitBreakerService.execute.mockResolvedValue({});

      const result = await service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444');

      expect(result.status).toBe('processing');
      expect(result.executionId).toBeDefined();
    });

    it('should throw 404 when Content Agent execution does not exist', async () => {
      agentMemoryService.getShortTermMemory.mockResolvedValue([]);

      await expect(
        service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444'),
      ).rejects.toThrow(HttpException);

      try {
        await service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444');
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND);
        expect((error as HttpException).message).toContain('não encontrada');
      }
    });

    it('should throw 404 when Content Agent execution belongs to another tenant (returns empty from memory)', async () => {
      // Agent memory filtered by tenantId returns no results
      agentMemoryService.getShortTermMemory.mockResolvedValue([]);

      await expect(
        service.fromContent(fromContentDto, 'other-tenant-id', '44444444-4444-4444-4444-444444444444'),
      ).rejects.toThrow(HttpException);

      try {
        await service.fromContent(fromContentDto, 'other-tenant-id', '44444444-4444-4444-4444-444444444444');
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND);
      }
    });

    it('should throw 409 when Content Agent execution has incompatible status', async () => {
      const errorMemory = [
        {
          ...mockContentMemory[0],
          content: JSON.stringify({
            status: 'error',
            sugestoes_visuais: {
              instagram: { formato: '4:5', descricao: 'Imagem elegante' },
            },
          }),
          metadata: { execution_id: contentExecutionId, version: 1, status: 'error' },
        },
      ];
      agentMemoryService.getShortTermMemory.mockResolvedValue(errorMemory);

      await expect(
        service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444'),
      ).rejects.toThrow(HttpException);

      try {
        await service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444');
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
        expect((error as HttpException).message).toContain('status incompatível');
      }
    });

    it('should throw 409 without revealing the actual status of content execution', async () => {
      const blockedMemory = [
        {
          ...mockContentMemory[0],
          content: JSON.stringify({
            status: 'guardrail_blocked',
            sugestoes_visuais: {},
          }),
          metadata: { execution_id: contentExecutionId, version: 1, status: 'guardrail_blocked' },
        },
      ];
      agentMemoryService.getShortTermMemory.mockResolvedValue(blockedMemory);

      try {
        await service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444');
      } catch (error) {
        const message = (error as HttpException).message;
        // Should NOT contain the actual status
        expect(message).not.toContain('guardrail_blocked');
        expect(message).not.toContain('error');
        expect((error as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
      }
    });

    it('should throw 422 when Content Agent execution has no visual suggestions', async () => {
      const noSuggestionsMemory = [
        {
          ...mockContentMemory[0],
          content: JSON.stringify({
            status: 'draft',
            sugestoes_visuais: {},
          }),
          metadata: { execution_id: contentExecutionId, version: 1, status: 'draft' },
        },
      ];
      agentMemoryService.getShortTermMemory.mockResolvedValue(noSuggestionsMemory);

      await expect(
        service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444'),
      ).rejects.toThrow(HttpException);

      try {
        await service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444');
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        expect((error as HttpException).message).toContain('sugestão visual');
      }
    });

    it('should throw 422 when visual suggestions exist but have no descricao', async () => {
      const noDescMemory = [
        {
          ...mockContentMemory[0],
          content: JSON.stringify({
            status: 'draft',
            sugestoes_visuais: {
              instagram: { formato: '4:5' }, // no descricao
            },
          }),
          metadata: { execution_id: contentExecutionId, version: 1, status: 'draft' },
        },
      ];
      agentMemoryService.getShortTermMemory.mockResolvedValue(noDescMemory);

      await expect(
        service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444'),
      ).rejects.toThrow(HttpException);

      try {
        await service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444');
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      }
    });

    it('should include content_execution_id in the persisted execution', async () => {
      agentMemoryService.getShortTermMemory.mockResolvedValue(mockContentMemory);
      circuitBreakerService.execute.mockResolvedValue({});

      await service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444');

      expect(executionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          contentExecutionId,
        }),
      );
    });

    it('should dispatch workflow asynchronously with correct metadata', async () => {
      agentMemoryService.getShortTermMemory.mockResolvedValue(mockContentMemory);
      circuitBreakerService.execute.mockResolvedValue({});

      await service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444');

      expect(circuitBreakerService.execute).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Function),
      );
    });

    it('should handle timeout when loading content execution (returns 404)', async () => {
      // Simulate timeout by making getShortTermMemory hang indefinitely
      agentMemoryService.getShortTermMemory.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 10000)),
      );

      await expect(
        service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444'),
      ).rejects.toThrow(HttpException);

      try {
        agentMemoryService.getShortTermMemory.mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve([]), 10000)),
        );
        await service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444');
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.NOT_FOUND);
      }
    }, 12000);

    it('should extract only social networks that have valid visual suggestions', async () => {
      const partialSuggestionsMemory = [
        {
          ...mockContentMemory[0],
          content: JSON.stringify({
            status: 'draft',
            sugestoes_visuais: {
              instagram: { formato: '4:5', descricao: 'Imagem elegante' },
              facebook: { formato: '1.91:1' }, // no descricao - should be excluded
              tiktok: { formato: '9:16', descricao: 'Video vertical' },
            },
          }),
          metadata: { execution_id: contentExecutionId, version: 1, status: 'draft' },
        },
      ];
      agentMemoryService.getShortTermMemory.mockResolvedValue(partialSuggestionsMemory);
      circuitBreakerService.execute.mockResolvedValue({});

      await service.fromContent(fromContentDto, tenantId, '44444444-4444-4444-4444-444444444444');

      expect(executionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          redesSociais: expect.arrayContaining(['instagram', 'tiktok']),
        }),
      );
      // facebook should NOT be included since it has no descricao
      const createCall = executionRepo.create.mock.calls[0][0];
      expect(createCall.redesSociais).not.toContain('facebook');
    });
  });
});
