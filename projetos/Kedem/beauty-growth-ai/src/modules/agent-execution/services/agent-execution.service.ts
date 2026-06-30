import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { AgentConfigService } from '../../agent-config/services/agent-config.service';
import { PromptRegistryService } from '../../prompt-registry/services/prompt-registry.service';
import { GuardrailsService } from '../../guardrails/services/guardrails.service';
import { AgentMemoryService } from '../../agent-memory/services/agent-memory.service';
import { ObservabilityService } from '../../observability/services/observability.service';
import { ModelRegistryService } from '../../model-registry/services/model-registry.service';

import { LangGraphClientService } from './langgraph-client.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { FallbackHandlerService } from './fallback-handler.service';

import {
  AgentExecutionRequest,
  AgentExecutionResult,
  IAgentExecutionService,
} from '../interfaces/agent-execution.interface';

import {
  ExecuteWorkflowRequest,
  ExecuteWorkflowResponse,
} from '../interfaces/grpc-types';

/**
 * AgentExecutionService orchestrates agent execution by delegating to the
 * LangGraph Python service via gRPC. Uses circuit breaker pattern for resilience
 * and falls back to a simplified local pipeline when LangGraph is unavailable.
 *
 * Pipeline:
 * 1. Load agent config (AgentConfigService)
 * 2. Resolve prompt from PromptRegistry (with template variables from tenant context)
 * 3. Validate input content via Guardrails (pre-generation)
 * 4. Delegate execution to LangGraph via gRPC (with circuit breaker + fallback)
 * 5. Persist interaction to Agent Memory (short-term)
 * 6. Log execution to Observability (with trace_id, tokens, duration, status)
 * 7. Track token usage via Model Registry
 *
 * Requirements: 1.1, 2.2
 */
@Injectable()
export class AgentExecutionService implements IAgentExecutionService {
  private readonly logger = new Logger(AgentExecutionService.name);

  constructor(
    private readonly agentConfigService: AgentConfigService,
    private readonly promptRegistryService: PromptRegistryService,
    private readonly guardrailsService: GuardrailsService,
    private readonly agentMemoryService: AgentMemoryService,
    private readonly observabilityService: ObservabilityService,
    private readonly modelRegistryService: ModelRegistryService,
    private readonly langGraphClient: LangGraphClientService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly fallbackHandler: FallbackHandlerService,
  ) {}

  /**
   * Execute the full agent pipeline end-to-end.
   * Delegates to LangGraph via gRPC with circuit breaker protection.
   */
  async execute(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    const startTime = Date.now();
    const traceId = this.observabilityService.generateTraceId();
    const guardrailViolations: string[] = [];

    this.logger.log(
      `[${traceId}] Starting execution for agent=${request.agentId} tenant=${request.tenantId}`,
    );

    try {
      // =====================================================================
      // STEP 1: Load agent configuration
      // =====================================================================
      const agentConfig = await this.loadAgentConfig(request.agentId);

      if (agentConfig.status !== 'active') {
        throw new ServiceUnavailableException(
          `Agent ${request.agentId} is not active (status: ${agentConfig.status})`,
        );
      }

      // =====================================================================
      // STEP 2: Resolve prompt from Prompt Registry
      // =====================================================================
      const resolvedPrompt = await this.resolvePrompt(
        agentConfig.systemPromptId,
        request.tenantContext || {},
      );

      // =====================================================================
      // STEP 3: Pre-generation guardrail validation (validate input)
      // =====================================================================
      const preValidation = await this.guardrailsService.validateWithRegeneration(
        request.userInput,
        request.tenantId,
        request.agentId,
        1,
      );

      if (preValidation.blocked) {
        const durationMs = Date.now() - startTime;
        const blockedViolations = preValidation.violations.map((v) => v.guardrailName);

        await this.logExecution(traceId, request, '', durationMs, 'error', {
          inputTokens: 0,
          outputTokens: 0,
        }, blockedViolations, agentConfig.modelId || '');

        return {
          success: false,
          output: '',
          traceId,
          modelId: agentConfig.modelId || '',
          usedFallback: false,
          tokensUsed: { inputTokens: 0, outputTokens: 0 },
          durationMs,
          blockedReason: 'Input content blocked by guardrails',
          guardrailViolations: blockedViolations,
        };
      }

      // =====================================================================
      // STEP 4: Delegate to LangGraph via gRPC (circuit breaker + fallback)
      // =====================================================================
      const grpcRequest = this.buildGrpcRequest(request, resolvedPrompt);

      const grpcResponse = await this.circuitBreaker.execute<ExecuteWorkflowResponse>(
        () => this.langGraphClient.executeWorkflow(grpcRequest),
        () => this.fallbackHandler.executeFallback(grpcRequest),
      );

      // =====================================================================
      // STEP 5: Map gRPC response to AgentExecutionResult
      // =====================================================================
      const usedFallback = grpcResponse.usedFallback;
      const modelId = grpcResponse.modelId || agentConfig.modelId || '';
      const output = grpcResponse.output;
      const tokensUsed = {
        inputTokens: grpcResponse.tokensUsed?.inputTokens ?? 0,
        outputTokens: grpcResponse.tokensUsed?.outputTokens ?? 0,
      };

      // Collect guardrail violations from response
      if (grpcResponse.guardrailViolations?.length > 0) {
        guardrailViolations.push(...grpcResponse.guardrailViolations);
      }

      // =====================================================================
      // STEP 6: Persist interaction to Agent Memory (short-term)
      // =====================================================================
      await this.persistToMemory(
        request.agentId,
        request.tenantId,
        request.userInput,
        output,
      );

      // =====================================================================
      // STEP 7: Log execution to Observability
      // =====================================================================
      const durationMs = Date.now() - startTime;
      const status = grpcResponse.success ? 'success' : 'error';

      await this.logExecution(
        traceId,
        request,
        output,
        durationMs,
        status,
        tokensUsed,
        guardrailViolations,
        modelId,
      );

      // =====================================================================
      // STEP 8: Track token usage via Model Registry
      // =====================================================================
      await this.modelRegistryService.trackUsage(request.tenantId, modelId, {
        inputTokens: tokensUsed.inputTokens,
        outputTokens: tokensUsed.outputTokens,
        agentId: request.agentId,
        timestamp: new Date(),
      });

      return {
        success: grpcResponse.success,
        output,
        traceId,
        modelId,
        usedFallback,
        tokensUsed,
        durationMs,
        blockedReason: grpcResponse.blockedReason || undefined,
        guardrailViolations:
          guardrailViolations.length > 0 ? guardrailViolations : undefined,
      };
    } catch (error: unknown) {
      const durationMs = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `[${traceId}] Execution failed for agent=${request.agentId}: ${message}`,
      );

      // Log the error to observability
      await this.logExecution(
        traceId,
        request,
        '',
        durationMs,
        'error',
        { inputTokens: 0, outputTokens: 0 },
        guardrailViolations,
        '',
      );

      throw error;
    }
  }

  // ===========================================================================
  // PRIVATE HELPERS
  // ===========================================================================

  /**
   * Step 1: Load agent config or throw.
   */
  private async loadAgentConfig(agentId: string) {
    const agents = await this.agentConfigService.list('__all__');
    const agent = agents.find((a) => a.id === agentId);

    if (!agent) {
      throw new NotFoundException(`Agent config not found: ${agentId}`);
    }

    return agent;
  }

  /**
   * Step 2: Resolve prompt with tenant context variables.
   */
  private async resolvePrompt(
    systemPromptId: string | null,
    tenantContext: Record<string, string>,
  ): Promise<string> {
    if (!systemPromptId) {
      return ''; // No prompt configured — agent runs without system prompt
    }

    const resolved = await this.promptRegistryService.resolve(
      systemPromptId,
      tenantContext,
    );

    if (resolved.unresolvedVariables.length > 0) {
      this.logger.warn(
        `Unresolved template variables: ${resolved.unresolvedVariables.join(', ')}`,
      );
    }

    return resolved.content;
  }

  /**
   * Build the gRPC ExecuteWorkflowRequest from the incoming AgentExecutionRequest.
   */
  private buildGrpcRequest(
    request: AgentExecutionRequest,
    _resolvedPrompt: string,
  ): ExecuteWorkflowRequest {
    return {
      agentId: request.agentId,
      tenantId: request.tenantId,
      userInput: request.userInput,
      userId: request.userId || '',
      tenantContext: request.tenantContext || {},
      workflowId: '',
      conversationId: '',
      options: {
        maxSteps: 50,
        timeoutMs: 120_000,
        enableStreaming: false,
        metadata: {},
      },
    };
  }

  /**
   * Persist both user input and assistant output to short-term memory.
   */
  private async persistToMemory(
    agentId: string,
    tenantId: string,
    userInput: string,
    assistantOutput: string,
  ): Promise<void> {
    // Persist user interaction
    await this.agentMemoryService.persistInteraction(agentId, {
      agentId,
      tenantId,
      role: 'user',
      content: userInput,
      timestamp: new Date(),
    });

    // Persist assistant response (only if there's output)
    if (assistantOutput) {
      await this.agentMemoryService.persistInteraction(agentId, {
        agentId,
        tenantId,
        role: 'assistant',
        content: assistantOutput,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Log execution to Observability with trace_id.
   */
  private async logExecution(
    traceId: string,
    request: AgentExecutionRequest,
    output: string,
    durationMs: number,
    status: 'success' | 'error',
    tokens: { inputTokens: number; outputTokens: number },
    guardrailViolations: string[],
    modelId: string,
  ): Promise<void> {
    await this.observabilityService.logAgentAction({
      traceId,
      tenantId: request.tenantId,
      agentId: request.agentId,
      actionType: 'agent_execution',
      input: request.userInput,
      output,
      durationMs,
      status,
      tokensUsed: {
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        modelId,
        agentId: request.agentId,
        timestamp: new Date(),
      },
      guardrailViolations:
        guardrailViolations.length > 0 ? guardrailViolations : undefined,
      timestamp: new Date(),
    });
  }
}
