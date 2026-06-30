import {
  Injectable,
  Logger,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

import { LangGraphClientService } from '../../agent-execution/services/langgraph-client.service';
import { CircuitBreakerService } from '../../agent-execution/services/circuit-breaker.service';
import { AgentMemoryService } from '../../agent-memory/services/agent-memory.service';
import { ObservabilityService } from '../../observability/services/observability.service';
import { GrpcClientError } from '../../agent-execution/services/grpc-error-handler';

import {
  ExecuteWorkflowRequest,
  ExecuteWorkflowResponse,
  ExecutionStatus,
} from '../../agent-execution/interfaces/grpc-types';

import {
  GenerateBriefingDto,
  RefineBriefingDto,
  ContentAgentResponse,
  RedeSocial,
  SugestaoVisual,
} from '../dto';

/**
 * ContentAgentService orchestrates content generation and refinement
 * by delegating to the LangGraph Content Agent workflow via gRPC.
 *
 * Responsibilities:
 * - Build gRPC ExecuteWorkflowRequest payloads specific to the content workflow
 * - Call LangGraphClientService.executeWorkflow() through CircuitBreakerService
 * - Map gRPC responses to ContentAgentResponse
 * - Track refinement versions and enforce max 5 limit
 * - Map gRPC errors to appropriate HTTP status codes
 *
 * Requirements: 1.4, 3.7, 5.1, 5.2, 5.4, 5.5, 6.3, 6.4
 */
@Injectable()
export class ContentAgentService {
  private readonly logger = new Logger(ContentAgentService.name);

  /** Maximum number of refinements allowed per execution */
  private static readonly MAX_REFINEMENTS = 5;

  /** Agent ID for the content agent in the agent router */
  private static readonly CONTENT_AGENT_ID = 'content';

  constructor(
    private readonly langGraphClient: LangGraphClientService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly agentMemoryService: AgentMemoryService,
    private readonly observabilityService: ObservabilityService,
  ) {}

  /**
   * Generate content based on a briefing.
   *
   * 1. Generates a unique execution_id (UUID v4)
   * 2. Builds gRPC request payload with briefing data as JSON input
   * 3. Calls LangGraphClientService.executeWorkflow() through CircuitBreakerService
   * 4. Maps the gRPC response (output JSON) to ContentAgentResponse
   *
   * Requirements: 1.4, 3.7
   */
  async generate(
    dto: GenerateBriefingDto,
    tenantId: string,
    userId: string,
  ): Promise<ContentAgentResponse> {
    const executionId = randomUUID();
    const traceId = this.observabilityService.generateTraceId();
    const startTime = Date.now();

    this.logger.log(
      `[${traceId}] Starting content generation: execution=${executionId} tenant=${tenantId}`,
    );

    try {
      const grpcRequest = this.buildGenerateRequest(
        dto,
        tenantId,
        userId,
        executionId,
        traceId,
      );

      const grpcResponse = await this.circuitBreaker.execute<ExecuteWorkflowResponse>(
        () => this.langGraphClient.executeWorkflow(grpcRequest),
        () => this.handleCircuitBreakerFallback(traceId),
      );

      const durationMs = Date.now() - startTime;
      return this.mapGrpcResponseToContentResponse(
        grpcResponse,
        executionId,
        1,
        durationMs,
      );
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      this.logger.error(
        `[${traceId}] Content generation failed: execution=${executionId} duration=${durationMs}ms`,
        error instanceof Error ? error.stack : String(error),
      );
      throw this.mapGrpcErrorToHttpException(error);
    }
  }

  /**
   * Refine previously generated content.
   *
   * 1. Validates refinement limit (max 5 per execution_id)
   * 2. Loads previous version from Agent Memory
   * 3. Builds gRPC request payload with is_refinement=true
   * 4. Delegates to LangGraph and maps response
   *
   * Requirements: 5.1, 5.2, 5.4, 5.5
   */
  async refine(
    dto: RefineBriefingDto,
    tenantId: string,
    userId: string,
  ): Promise<ContentAgentResponse> {
    const traceId = this.observabilityService.generateTraceId();
    const startTime = Date.now();

    this.logger.log(
      `[${traceId}] Starting content refinement: execution=${dto.executionId} tenant=${tenantId}`,
    );

    // Step 1: Load previous execution from Agent Memory and validate ownership
    const previousExecution = await this.loadPreviousExecution(
      dto.executionId,
      tenantId,
    );

    if (!previousExecution) {
      // Return 404 without revealing if execution_id exists for another tenant
      // Requirement 5.5
      throw new NotFoundException(
        'Execução não encontrada ou não pertence ao tenant informado',
      );
    }

    // Step 2: Validate refinement limit (max 5)
    const currentVersion = previousExecution.version;
    if (currentVersion >= ContentAgentService.MAX_REFINEMENTS + 1) {
      // version starts at 1 for original, so max version = 6 means 5 refinements done
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Limite de refinamentos atingido (máximo ${ContentAgentService.MAX_REFINEMENTS} por execução)`,
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      // Step 3: Build gRPC request with refinement metadata
      const nextVersion = currentVersion + 1;
      const grpcRequest = this.buildRefineRequest(
        dto,
        tenantId,
        userId,
        traceId,
        nextVersion,
      );

      // Step 4: Execute via circuit breaker
      const grpcResponse = await this.circuitBreaker.execute<ExecuteWorkflowResponse>(
        () => this.langGraphClient.executeWorkflow(grpcRequest),
        () => this.handleCircuitBreakerFallback(traceId),
      );

      const durationMs = Date.now() - startTime;
      return this.mapGrpcResponseToContentResponse(
        grpcResponse,
        dto.executionId,
        nextVersion,
        durationMs,
      );
    } catch (error: unknown) {
      // Don't re-wrap HttpExceptions (already mapped)
      if (error instanceof HttpException) {
        throw error;
      }

      const durationMs = Date.now() - startTime;
      this.logger.error(
        `[${traceId}] Content refinement failed: execution=${dto.executionId} duration=${durationMs}ms`,
        error instanceof Error ? error.stack : String(error),
      );
      throw this.mapGrpcErrorToHttpException(error);
    }
  }

  // ===========================================================================
  // PRIVATE HELPERS — Request Building
  // ===========================================================================

  /**
   * Build gRPC ExecuteWorkflowRequest for content generation.
   * Converts the briefing DTO into the JSON input expected by the LangGraph workflow.
   */
  private buildGenerateRequest(
    dto: GenerateBriefingDto,
    tenantId: string,
    userId: string,
    executionId: string,
    traceId: string,
  ): ExecuteWorkflowRequest {
    const input = JSON.stringify({
      execution_id: executionId,
      tema: dto.tema,
      procedimento: dto.procedimento || null,
      publico_alvo_override: dto.publicoAlvoOverride || null,
      redes_sociais: dto.redesSociais,
      idioma: dto.idioma || 'pt-BR',
      is_refinement: false,
    });

    return {
      agentId: ContentAgentService.CONTENT_AGENT_ID,
      tenantId,
      userInput: input,
      userId,
      tenantContext: {},
      workflowId: 'content_agent_workflow',
      conversationId: executionId,
      options: {
        maxSteps: 50,
        timeoutMs: 60_000,
        enableStreaming: false,
        metadata: {
          trace_id: traceId,
          execution_id: executionId,
          workflow_type: 'content_generation',
        },
      },
    };
  }

  /**
   * Build gRPC ExecuteWorkflowRequest for content refinement.
   * Includes is_refinement=true and original_execution_id in the payload.
   */
  private buildRefineRequest(
    dto: RefineBriefingDto,
    tenantId: string,
    userId: string,
    traceId: string,
    version: number,
  ): ExecuteWorkflowRequest {
    const input = JSON.stringify({
      execution_id: dto.executionId,
      instrucoes: dto.instrucoes,
      is_refinement: true,
      original_execution_id: dto.executionId,
      version,
    });

    return {
      agentId: ContentAgentService.CONTENT_AGENT_ID,
      tenantId,
      userInput: input,
      userId,
      tenantContext: {},
      workflowId: 'content_agent_workflow',
      conversationId: dto.executionId,
      options: {
        maxSteps: 50,
        timeoutMs: 60_000,
        enableStreaming: false,
        metadata: {
          trace_id: traceId,
          execution_id: dto.executionId,
          workflow_type: 'content_refinement',
          version: String(version),
        },
      },
    };
  }

  // ===========================================================================
  // PRIVATE HELPERS — Response Mapping
  // ===========================================================================

  /**
   * Map gRPC ExecuteWorkflowResponse to ContentAgentResponse.
   * Parses the output JSON from LangGraph and extracts content fields.
   *
   * Requirements: 3.7
   */
  private mapGrpcResponseToContentResponse(
    grpcResponse: ExecuteWorkflowResponse,
    executionId: string,
    version: number,
    durationMs: number,
  ): ContentAgentResponse {
    // Determine status based on gRPC response
    const status = this.resolveContentStatus(grpcResponse);

    // If blocked, throw 422
    if (status === 'guardrail_blocked') {
      throw new HttpException(
        {
          statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
          message:
            grpcResponse.blockedReason ||
            'O conteúdo solicitado não pode ser gerado em conformidade com as políticas vigentes',
          error: 'Unprocessable Entity',
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Parse the output JSON from LangGraph
    const parsedOutput = this.parseWorkflowOutput(grpcResponse.output);

    return {
      executionId,
      status,
      version,
      legendas: parsedOutput.legendas || ({} as Record<RedeSocial, string>),
      hashtags: parsedOutput.hashtags || [],
      sugestoesVisuais:
        parsedOutput.sugestoes_visuais ||
        ({} as Record<RedeSocial, SugestaoVisual>),
      modeloUtilizado: grpcResponse.modelId || parsedOutput.model_id || '',
      usouFallback: grpcResponse.usedFallback || false,
      tokensConsumidos: {
        input: grpcResponse.tokensUsed?.inputTokens ?? 0,
        output: grpcResponse.tokensUsed?.outputTokens ?? 0,
      },
      duracaoMs: durationMs,
    };
  }

  /**
   * Resolve the content status from a gRPC response.
   */
  private resolveContentStatus(
    grpcResponse: ExecuteWorkflowResponse,
  ): 'draft' | 'guardrail_blocked' | 'error' {
    if (
      grpcResponse.blockedReason &&
      grpcResponse.blockedReason.length > 0
    ) {
      return 'guardrail_blocked';
    }

    if (!grpcResponse.success) {
      return 'error';
    }

    return 'draft';
  }

  /**
   * Parse the output JSON string from the LangGraph workflow response.
   * The output field contains a serialized JSON with content fields.
   */
  private parseWorkflowOutput(output: string): {
    legendas?: Record<RedeSocial, string>;
    hashtags?: string[];
    sugestoes_visuais?: Record<RedeSocial, SugestaoVisual>;
    model_id?: string;
  } {
    if (!output) {
      return {};
    }

    try {
      return JSON.parse(output);
    } catch {
      this.logger.warn(`Failed to parse workflow output as JSON: ${output.substring(0, 200)}`);
      return {};
    }
  }

  // ===========================================================================
  // PRIVATE HELPERS — Refinement Version Tracking
  // ===========================================================================

  /**
   * Load previous execution data from Agent Memory.
   * Returns null if execution not found or does not belong to the given tenant.
   *
   * The execution data is stored in Agent Memory short-term as an assistant
   * message with metadata containing execution_id, version, and tenant_id.
   *
   * Requirements: 5.1, 5.5
   */
  private async loadPreviousExecution(
    executionId: string,
    tenantId: string,
  ): Promise<{ version: number } | null> {
    try {
      const shortTermMemory = await this.agentMemoryService.getShortTermMemory(
        ContentAgentService.CONTENT_AGENT_ID,
        tenantId,
      );

      // Find interactions related to this execution_id
      const executionInteractions = shortTermMemory.filter(
        (interaction) =>
          interaction.metadata?.execution_id === executionId &&
          interaction.role === 'assistant',
      );

      if (executionInteractions.length === 0) {
        return null;
      }

      // Get the highest version from the interactions
      const maxVersion = executionInteractions.reduce(
        (max, interaction) => {
          const v = interaction.metadata?.version ?? 1;
          return v > max ? v : max;
        },
        1,
      );

      return { version: maxVersion };
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to load previous execution ${executionId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  // ===========================================================================
  // PRIVATE HELPERS — Error Handling
  // ===========================================================================

  /**
   * Fallback handler when circuit breaker is open.
   * The Content Agent does NOT have a simplified fallback — it returns 503.
   *
   * Requirements: 6.3
   */
  private async handleCircuitBreakerFallback(
    traceId: string,
  ): Promise<ExecuteWorkflowResponse> {
    this.logger.warn(
      `[${traceId}] Circuit breaker open — LangGraph service unavailable for content generation`,
    );

    throw new HttpException(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message:
          'Serviço de geração de conteúdo temporariamente indisponível. Tente novamente em alguns minutos.',
        error: 'Service Unavailable',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  /**
   * Map gRPC errors to appropriate HTTP exceptions.
   *
   * Mapping:
   * - FAILED_PRECONDITION (code 9) → 412 (Business Memory sem tom_de_voz)
   * - INVALID_ARGUMENT (code 3) → 422 (Guardrail blocked, invalid input)
   * - RESOURCE_EXHAUSTED (code 8) → 429 (Rate limit / refinement limit)
   * - UNAVAILABLE (code 14) → 503 (Service unavailable)
   * - DEADLINE_EXCEEDED (code 4) → 504 (Timeout)
   * - Others → 500
   *
   * Requirements: 6.3, 6.4
   */
  private mapGrpcErrorToHttpException(error: unknown): HttpException {
    if (error instanceof HttpException) {
      return error;
    }

    if (error instanceof GrpcClientError) {
      switch (error.code) {
        case 9: // FAILED_PRECONDITION
          return new HttpException(
            {
              statusCode: HttpStatus.PRECONDITION_FAILED,
              message:
                error.message ||
                'Pré-condição não atendida. Verifique se a identidade da marca (tom de voz) está configurada.',
              error: 'Precondition Failed',
            },
            HttpStatus.PRECONDITION_FAILED,
          );

        case 3: // INVALID_ARGUMENT
          return new HttpException(
            {
              statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
              message:
                error.message ||
                'O conteúdo não pode ser gerado em conformidade com as políticas vigentes.',
              error: 'Unprocessable Entity',
            },
            HttpStatus.UNPROCESSABLE_ENTITY,
          );

        case 8: // RESOURCE_EXHAUSTED
          return new HttpException(
            {
              statusCode: HttpStatus.TOO_MANY_REQUESTS,
              message:
                error.message || 'Limite de requisições atingido. Tente novamente mais tarde.',
              error: 'Too Many Requests',
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );

        case 14: // UNAVAILABLE
          return new HttpException(
            {
              statusCode: HttpStatus.SERVICE_UNAVAILABLE,
              message:
                'Serviço de geração de conteúdo temporariamente indisponível. Tente novamente em alguns minutos.',
              error: 'Service Unavailable',
            },
            HttpStatus.SERVICE_UNAVAILABLE,
          );

        case 4: // DEADLINE_EXCEEDED
          return new HttpException(
            {
              statusCode: HttpStatus.GATEWAY_TIMEOUT,
              message:
                'Tempo limite excedido para geração de conteúdo. Tente novamente.',
              error: 'Gateway Timeout',
            },
            HttpStatus.GATEWAY_TIMEOUT,
          );

        default:
          return new HttpException(
            {
              statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
              message: error.message || 'Erro interno ao gerar conteúdo.',
              error: 'Internal Server Error',
            },
            HttpStatus.INTERNAL_SERVER_ERROR,
          );
      }
    }

    // Unknown error type
    const message = error instanceof Error ? error.message : String(error);
    return new HttpException(
      {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: message || 'Erro interno ao gerar conteúdo.',
        error: 'Internal Server Error',
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
