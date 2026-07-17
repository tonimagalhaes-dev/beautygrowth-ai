import { Injectable, Logger, NotFoundException, HttpException, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { LangGraphClientService } from '../../agent-execution/services/langgraph-client.service';
import { CircuitBreakerService } from '../../agent-execution/services/circuit-breaker.service';
import { AgentMemoryService } from '../../agent-memory/services/agent-memory.service';
import { ObservabilityService } from '../../observability/services/observability.service';
import { PromptCacheService } from '../../prompt-cache/services/prompt-cache.service';

import {
  GenerateImageDto,
  EditImageDto,
  FromContentDto,
  DesignerAgentResponse,
  GenerateAcceptedResponse,
  ImageResult,
} from '../dto';
import { RedeSocial } from '../dto/generate-image.dto';
import { DesignerExecution } from '../entities/designer-execution.entity';
import { DesignerImage } from '../entities/designer-image.entity';
import { DesignerEditHistory } from '../entities/designer-edit-history.entity';

/** Presigned URL validity: 7 days in seconds */
const PRESIGNED_URL_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/** Threshold for regenerating URLs: regenerate if expiring within 1 day */
const PRESIGNED_URL_REFRESH_THRESHOLD_MS = 1 * 24 * 60 * 60 * 1000;

/**
 * DesignerAgentService orchestrates image generation, editing, and retrieval
 * by delegating to the LangGraph Designer Agent workflow via gRPC.
 *
 * Responsibilities:
 * - Build gRPC ExecuteWorkflowRequest payloads for image generation
 * - Call LangGraphClientService.executeWorkflow() through CircuitBreakerService
 * - Map gRPC responses to DesignerAgentResponse
 * - Track edit versions and enforce max 5 edits per social network
 * - Integrate with Content Agent executions
 * - Regenerate presigned URLs when expired
 *
 * Requirements: 1.1, 1.5, 4.5, 8.1, 8.3, 8.4
 */
@Injectable()
export class DesignerAgentService {
  private readonly logger = new Logger(DesignerAgentService.name);
  private readonly s3Client: S3Client;
  private readonly bucket: string;

  /** Agent ID for the designer agent in the agent router */
  private static readonly DESIGNER_AGENT_ID = 'designer';

  /** Maximum number of edits allowed per social network */
  private static readonly MAX_EDITS_PER_SOCIAL = 5;

  constructor(
    private readonly langGraphClient: LangGraphClientService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly agentMemoryService: AgentMemoryService,
    private readonly observabilityService: ObservabilityService,
    private readonly configService: ConfigService,
    private readonly promptCacheService: PromptCacheService,
    @InjectRepository(DesignerExecution)
    private readonly executionRepository: Repository<DesignerExecution>,
    @InjectRepository(DesignerImage)
    private readonly imageRepository: Repository<DesignerImage>,
    @InjectRepository(DesignerEditHistory)
    private readonly editHistoryRepository: Repository<DesignerEditHistory>,
  ) {
    this.bucket = this.configService.get<string>('S3_BUCKET', 'beauty-growth-ai');
    const endpoint = this.configService.get<string>('S3_ENDPOINT', 'http://localhost:9000');
    const region = this.configService.get<string>('S3_REGION', 'us-east-1');
    const accessKeyId =
      this.configService.get<string>('S3_ACCESS_KEY_ID', '') ||
      this.configService.get<string>('S3_ACCESS_KEY', 'beautygrowth');
    const secretAccessKey =
      this.configService.get<string>('S3_SECRET_ACCESS_KEY', '') ||
      this.configService.get<string>('S3_SECRET_KEY', 'beautygrowth_dev');

    this.s3Client = new S3Client({
      region,
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });
  }

  /**
   * Initiates image generation for the given briefing.
   * Returns immediately with execution_id and status "processing".
   * The actual generation happens asynchronously via LangGraph.
   * Propagates trace_id from request header or generates a new UUID v4.
   *
   * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 10.2, 10.6
   */
  async generate(
    dto: GenerateImageDto,
    tenantId: string,
    userId: string,
    traceId?: string,
  ): Promise<GenerateAcceptedResponse> {
    const resolvedTraceId = traceId || this.observabilityService.generateTraceId();
    this.logger.log(
      `Initiating image generation for tenant=${tenantId}, user=${userId}, trace_id=${resolvedTraceId}`,
    );

    // TODO: Implement in task 2.1
    throw new Error('Method not implemented');
  }

  /**
   * Performs iterative editing on a previously generated image.
   * Validates edit count limit (max 5 per social network).
   * This is a SYNCHRONOUS call — waits for the LangGraph workflow to complete.
   * Propagates trace_id from request header or generates a new UUID v4.
   *
   * Requirements: 6.1, 6.2, 6.3, 6.5, 10.2, 10.6
   */
  async edit(
    dto: EditImageDto,
    tenantId: string,
    userId: string,
    traceId?: string,
  ): Promise<DesignerAgentResponse> {
    const resolvedTraceId = traceId || this.observabilityService.generateTraceId();
    this.logger.log(
      `Editing image execution=${dto.executionId}, rede=${dto.redeSocial}, tenant=${tenantId}, trace_id=${resolvedTraceId}`,
    );

    // 1. Verify execution exists and belongs to the tenant
    const execution = await this.executionRepository.findOne({
      where: { executionId: dto.executionId, tenantId },
    });

    if (!execution) {
      throw new NotFoundException('Execução não encontrada');
    }

    // 2. Count existing edits in designer_edit_history for (execution_id, rede_social)
    const editCount = await this.editHistoryRepository.count({
      where: {
        executionId: dto.executionId,
        redeSocial: dto.redeSocial,
      },
    });

    if (editCount >= DesignerAgentService.MAX_EDITS_PER_SOCIAL) {
      throw new HttpException(
        `Limite de ${DesignerAgentService.MAX_EDITS_PER_SOCIAL} edições por rede social atingido para ${dto.redeSocial}`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // 3. Build the gRPC ExecuteWorkflowRequest with is_edit=true
    const workflowRequest = {
      agentId: DesignerAgentService.DESIGNER_AGENT_ID,
      tenantId,
      userId,
      userInput: dto.instrucaoEdicao,
      tenantContext: {},
      workflowId: 'designer',
      conversationId: dto.executionId,
      options: {
        maxSteps: 10,
        timeoutMs: 120000,
        enableStreaming: false,
        metadata: {
          is_edit: 'true',
          original_execution_id: dto.executionId,
          target_social: dto.redeSocial,
          edit_instruction: dto.instrucaoEdicao,
        },
      },
    };

    // 4. Call LangGraph workflow synchronously (edit waits for result)
    const grpcResponse = await this.circuitBreaker.execute(
      () => this.langGraphClient.executeWorkflow(workflowRequest),
      async () => {
        throw new HttpException(
          'Serviço de geração de imagens indisponível temporariamente',
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      },
    );

    // 5. Map the gRPC response to DesignerAgentResponse
    const output = grpcResponse.output ? JSON.parse(grpcResponse.output) : {};

    const images: Record<RedeSocial, ImageResult> = {} as Record<RedeSocial, ImageResult>;

    if (output.images) {
      for (const [rede, imgData] of Object.entries(output.images)) {
        const img = imgData as any;
        images[rede as RedeSocial] = {
          url: img.url || '',
          urlThumbnail: img.url_thumbnail || img.urlThumbnail || '',
          urlSemOverlay: img.url_sem_overlay || img.urlSemOverlay || undefined,
          redeSocial: rede as RedeSocial,
          aspectoRatio: img.aspecto_ratio || img.aspectoRatio || '',
          tamanhoBytes: img.tamanho_bytes || img.tamanhoBytes || 0,
          status: img.status || 'generated',
          erroDetalhe: img.erro_detalhe || img.erroDetalhe || undefined,
        };
      }
    }

    return {
      executionId: dto.executionId,
      status: output.status || 'generated',
      contentExecutionId: execution.contentExecutionId || undefined,
      images,
      modeloUtilizado: grpcResponse.modelId || output.modelo_utilizado || '',
      usouFallback: grpcResponse.usedFallback || false,
      tokensConsumidos:
        (grpcResponse.tokensUsed?.inputTokens || 0) + (grpcResponse.tokensUsed?.outputTokens || 0),
      duracaoMs: grpcResponse.durationMs || 0,
      version: output.version || execution.version + 1,
      logoOverlayAplicado: output.logo_overlay_aplicado || execution.logoOverlayAplicado || false,
      warnings: output.warnings || grpcResponse.guardrailViolations || [],
    };
  }

  /**
   * Generates images from a Content Agent execution.
   * Extracts social networks and visual suggestions automatically.
   *
   * SLA: Must accept/reject within 5 seconds.
   *
   * Flow:
   * 1. Load Content Agent execution from Agent Memory (with 5s timeout)
   * 2. Validate existence and tenant ownership (404 if not found)
   * 3. Validate status is 'draft' or 'approved' (409 if incompatible)
   * 4. Extract redes_sociais and sugestões visuais (422 if not available)
   * 5. Build descricao_visual from visual suggestions
   * 6. Create initial designer_executions row
   * 7. Dispatch LangGraph workflow asynchronously
   * 8. Return 202 with {executionId, status: 'processing'}
   *
   * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 10.2, 10.6
   */
  async fromContent(
    dto: FromContentDto,
    tenantId: string,
    userId: string,
    traceId?: string,
  ): Promise<GenerateAcceptedResponse> {
    const resolvedTraceId = traceId || this.observabilityService.generateTraceId();
    this.logger.log(
      `Generating from content execution=${dto.contentExecutionId}, tenant=${tenantId}, trace_id=${resolvedTraceId}`,
    );

    // 1. Load Content Agent execution data from Agent Memory (5s timeout)
    const contentData = await this.loadContentAgentExecution(dto.contentExecutionId, tenantId);

    // 2. Validate existence and tenant ownership (returns null if not found or wrong tenant)
    if (!contentData) {
      throw new HttpException('Execução de conteúdo não encontrada', HttpStatus.NOT_FOUND);
    }

    // 3. Validate status is 'draft' or 'approved'
    if (!['draft', 'approved'].includes(contentData.status)) {
      throw new HttpException(
        'O conteúdo vinculado possui status incompatível para geração de imagens',
        HttpStatus.CONFLICT,
      );
    }

    // 4. Extract redes_sociais and validate visual suggestions exist
    const redesSociais = Object.keys(contentData.sugestoesVisuais || {}) as RedeSocial[];

    if (redesSociais.length === 0) {
      throw new HttpException(
        'O conteúdo vinculado não possui sugestão visual disponível para as redes solicitadas',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Validate that visual suggestions have 'descricao' field
    const validSuggestions = redesSociais.filter(
      (rede) => contentData.sugestoesVisuais[rede]?.descricao,
    );

    if (validSuggestions.length === 0) {
      throw new HttpException(
        'O conteúdo vinculado não possui sugestão visual disponível para as redes solicitadas',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // 5. Build descricao_visual from visual suggestions
    const descricaoVisual = validSuggestions
      .map((rede) => `[${rede}] ${contentData.sugestoesVisuais[rede].descricao}`)
      .join('; ');

    // 6. Create initial designer_executions row
    const executionId = randomUUID();

    const execution = this.executionRepository.create({
      executionId,
      tenantId,
      userId,
      contentExecutionId: dto.contentExecutionId,
      status: 'processing',
      descricaoVisual,
      redesSociais: validSuggestions,
      estiloVisualAdicional: dto.estiloVisualAdicional || null,
      aplicarLogoOverlay: dto.aplicarLogoOverlay ?? false,
      traceId: resolvedTraceId.replace(/^trace-/, ''),
    });

    await this.executionRepository.save(execution);

    // 7. Dispatch LangGraph workflow asynchronously (fire-and-forget)
    const workflowRequest = {
      agentId: DesignerAgentService.DESIGNER_AGENT_ID,
      tenantId,
      userId,
      userInput: JSON.stringify({
        execution_id: executionId,
        descricao_visual: descricaoVisual,
        redes_sociais: validSuggestions,
        content_execution_id: dto.contentExecutionId,
        aplicar_logo_overlay: dto.aplicarLogoOverlay ?? false,
        estilo_visual_adicional: dto.estiloVisualAdicional || '',
      }),
      tenantContext: {},
      workflowId: 'designer',
      conversationId: executionId,
      options: {
        maxSteps: 10,
        timeoutMs: 120000,
        enableStreaming: false,
        metadata: {
          execution_id: executionId,
          trace_id: resolvedTraceId,
          workflow_type: 'from_content',
        },
      },
    };

    // Async dispatch — do not await (same pattern as generate())
    this.circuitBreaker
      .execute(
        () => this.langGraphClient.executeWorkflow(workflowRequest),
        async () => {
          // On circuit breaker failure, update execution status to error
          await this.executionRepository.update(
            { executionId },
            {
              status: 'error',
              warnings: ['Serviço de geração de imagens indisponível temporariamente'],
            },
          );
          throw new HttpException(
            'Serviço de geração de imagens indisponível temporariamente',
            HttpStatus.SERVICE_UNAVAILABLE,
          );
        },
      )
      .then((response) => {
        this.logger.log(
          `[${resolvedTraceId}] Workflow completed for execution=${executionId}, success=${response?.success}`,
        );

        // Associate generated images with prompt cache entry (non-blocking)
        this.associateImagesWithCache(executionId, dto.contentExecutionId, tenantId).catch(
          (err) => {
            this.logger.warn(
              `[${resolvedTraceId}] Failed to associate images with cache for execution=${executionId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          },
        );
      })
      .catch((error) => {
        this.logger.error(
          `[${resolvedTraceId}] Async workflow dispatch failed for execution=${executionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        // Update execution status to error (best-effort)
        this.executionRepository.update({ executionId }, { status: 'error' }).catch(() => {
          /* ignore update failure */
        });
      });

    // 8. Return 202 with processing status
    return {
      executionId,
      status: 'processing',
    };
  }

  /**
   * Associates generated images with the prompt cache entry after workflow completion.
   * Queries the designer_images table for the given designer executionId,
   * then calls PromptCacheService.associateImages() with the contentExecutionId.
   *
   * This is non-blocking — errors are logged but do not affect the main flow.
   *
   * Requirements: 1.2
   */
  private async associateImagesWithCache(
    designerExecutionId: string,
    contentExecutionId: string,
    tenantId: string,
  ): Promise<void> {
    try {
      // Query the latest images for this designer execution
      const images = await this.imageRepository.find({
        where: { executionId: designerExecutionId, isLatest: true },
      });

      if (images.length === 0) {
        this.logger.debug(
          `No images found for designer execution=${designerExecutionId}, skipping cache association`,
        );
        return;
      }

      // Map to the format expected by PromptCacheService.associateImages()
      const imageReferences = images.map((image) => ({
        imageId: image.id,
        url: image.urlPresigned || '',
        redeSocial: image.redeSocial,
      }));

      await this.promptCacheService.associateImages(contentExecutionId, tenantId, imageReferences);

      this.logger.log(
        `Associated ${imageReferences.length} images with cache entry for contentExecution=${contentExecutionId}`,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(
        `Failed to associate images with cache for contentExecution=${contentExecutionId}: ${err.message}`,
        err.stack,
      );
    }
  }

  /**
   * Loads a Content Agent execution from the workflow_executions table.
   * Returns the execution data with status and visual suggestions if found and belongs to tenant.
   * Returns null if not found or belongs to another tenant.
   *
   * Queries by conversation_id (the Content Agent's executionId) which corresponds
   * to the contentExecutionId passed from the frontend.
   *
   * Applies a 5-second timeout to ensure SLA compliance (Requirement 9.1).
   */
  private async loadContentAgentExecution(
    contentExecutionId: string,
    tenantId: string,
  ): Promise<{
    status: string;
    sugestoesVisuais: Record<string, { formato?: string; descricao: string }>;
    redesSociais?: string[];
  } | null> {
    const TIMEOUT_MS = 5000;

    try {
      const queryPromise = this.executionRepository.manager.query(
        `SELECT id, tenant_id, workflow_id, status, output
         FROM workflow_executions
         WHERE conversation_id = $1
           AND tenant_id = $2
           AND workflow_id IN ('content', 'content_agent')
         ORDER BY created_at DESC
         LIMIT 1`,
        [contentExecutionId, tenantId],
      );

      // Apply 5-second timeout
      const rows = await Promise.race([
        queryPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timeout loading content execution')), TIMEOUT_MS),
        ),
      ]);

      if (!rows || rows.length === 0) {
        return null;
      }

      const row = rows[0];
      const dbStatus = row.status;

      // Map DB status to content status
      const status = dbStatus === 'completed' || dbStatus === 'success' ? 'draft' : dbStatus;

      // Parse output JSON to extract visual suggestions
      let parsedOutput: any = {};
      if (row.output) {
        try {
          parsedOutput = typeof row.output === 'string' ? JSON.parse(row.output) : row.output;
        } catch {
          return null;
        }
      }

      const sugestoesVisuais =
        parsedOutput.sugestoes_visuais || parsedOutput.sugestoesVisuais || {};
      const redesSociais =
        parsedOutput.redes_sociais || parsedOutput.redesSociais || Object.keys(sugestoesVisuais);

      return {
        status,
        sugestoesVisuais,
        redesSociais,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to load content execution ${contentExecutionId}: ${message}`);
      return null;
    }
  }

  /**
   * Retrieves the current status and results of an execution.
   * Queries designer_executions joined with designer_images (is_latest=true).
   * RLS handles tenant isolation automatically via the TenantInterceptor.
   * Regenerates presigned URLs if expired or expiring within 1 day.
   *
   * Requirements: 4.5, 8.1, 8.3, 8.4
   */
  async getExecution(executionId: string, tenantId: string): Promise<DesignerAgentResponse> {
    this.logger.log(`Getting execution=${executionId}, tenant=${tenantId}`);

    // Query execution (RLS filters by tenant automatically)
    const execution = await this.executionRepository.findOne({
      where: { executionId },
    });

    if (!execution) {
      throw new NotFoundException(`Execução ${executionId} não encontrada`);
    }

    // Query latest images for this execution
    const images = await this.imageRepository.find({
      where: { executionId, isLatest: true },
    });

    // Check if presigned URLs need regeneration
    const refreshedImages = await this.refreshPresignedUrlsIfNeeded(images);

    // Map images to response format
    const imagesRecord: Record<RedeSocial, ImageResult> = {} as Record<RedeSocial, ImageResult>;

    for (const image of refreshedImages) {
      imagesRecord[image.redeSocial] = {
        url: image.urlPresigned || '',
        urlThumbnail: image.urlPresignedThumbnail || '',
        urlSemOverlay: image.urlPresignedSemOverlay || undefined,
        redeSocial: image.redeSocial,
        aspectoRatio: image.aspectoRatio,
        tamanhoBytes: image.tamanhoBytes,
        status: 'generated',
      };
    }

    return {
      executionId: execution.executionId,
      status: execution.status,
      contentExecutionId: execution.contentExecutionId || undefined,
      images: imagesRecord,
      modeloUtilizado: execution.modeloUtilizado || '',
      usouFallback: execution.usouFallback,
      tokensConsumidos: execution.tokensConsumidos,
      duracaoMs: execution.duracaoMs || 0,
      version: execution.version,
      logoOverlayAplicado: execution.logoOverlayAplicado,
      warnings: execution.warnings || [],
    };
  }

  /**
   * Returns a presigned download URL for a specific image.
   * Regenerates the URL if expired or expiring within 1 day.
   *
   * Requirements: 4.5, 8.3
   */
  async getDownloadUrl(executionId: string, imageId: string, tenantId: string): Promise<string> {
    this.logger.log(
      `Getting download URL for execution=${executionId}, image=${imageId}, tenant=${tenantId}`,
    );

    // RLS handles tenant isolation automatically
    const image = await this.imageRepository.findOne({
      where: { id: imageId, executionId },
    });

    if (!image) {
      throw new NotFoundException(`Imagem ${imageId} não encontrada na execução ${executionId}`);
    }

    // Check if URL needs regeneration
    if (this.isPresignedUrlExpiredOrExpiring(image.urlPresignedExpiresAt)) {
      const newUrl = await this.generatePresignedUrl(image.minioPath);
      const newExpiresAt = new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000);

      await this.imageRepository.update(
        { id: image.id },
        {
          urlPresigned: newUrl,
          urlPresignedExpiresAt: newExpiresAt,
        },
      );

      return newUrl;
    }

    return image.urlPresigned || (await this.generatePresignedUrl(image.minioPath));
  }

  /**
   * Checks whether a presigned URL has expired or is expiring within the refresh threshold (1 day).
   */
  private isPresignedUrlExpiredOrExpiring(expiresAt: Date | null): boolean {
    if (!expiresAt) {
      return true;
    }
    const now = Date.now();
    const expirationTime = expiresAt.getTime();
    return expirationTime - now < PRESIGNED_URL_REFRESH_THRESHOLD_MS;
  }

  /**
   * Generates a new presigned URL for the given MinIO object path.
   * URL is valid for 7 days.
   */
  private async generatePresignedUrl(minioPath: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: minioPath,
    });

    return getSignedUrl(this.s3Client, command, {
      expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
    });
  }

  /**
   * Refreshes presigned URLs for images that are expired or expiring within 1 day.
   * Updates the database with new URLs and expiration timestamps.
   * Returns the updated image records.
   */
  private async refreshPresignedUrlsIfNeeded(images: DesignerImage[]): Promise<DesignerImage[]> {
    const refreshedImages: DesignerImage[] = [];

    for (const image of images) {
      if (this.isPresignedUrlExpiredOrExpiring(image.urlPresignedExpiresAt)) {
        this.logger.log(
          `Regenerating presigned URLs for image=${image.id}, rede=${image.redeSocial}`,
        );

        const newExpiresAt = new Date(Date.now() + PRESIGNED_URL_EXPIRY_SECONDS * 1000);

        // Generate new presigned URLs
        const newUrl = await this.generatePresignedUrl(image.minioPath);
        const newThumbnailUrl = await this.generatePresignedUrl(image.minioPathThumbnail);
        const newSemOverlayUrl = image.minioPathSemOverlay
          ? await this.generatePresignedUrl(image.minioPathSemOverlay)
          : null;

        // Update in database
        await this.imageRepository.update(
          { id: image.id },
          {
            urlPresigned: newUrl,
            urlPresignedThumbnail: newThumbnailUrl,
            urlPresignedSemOverlay: newSemOverlayUrl,
            urlPresignedExpiresAt: newExpiresAt,
          },
        );

        // Return updated image
        refreshedImages.push({
          ...image,
          urlPresigned: newUrl,
          urlPresignedThumbnail: newThumbnailUrl,
          urlPresignedSemOverlay: newSemOverlayUrl,
          urlPresignedExpiresAt: newExpiresAt,
        });
      } else {
        refreshedImages.push(image);
      }
    }

    return refreshedImages;
  }
}
