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

import {
  AgentExecutionRequest,
  AgentExecutionResult,
  IAgentExecutionService,
} from '../interfaces/agent-execution.interface';

/**
 * AgentExecutionService orchestrates the full agent execution pipeline:
 *
 * 1. Load agent config (AgentConfigService)
 * 2. Resolve prompt from PromptRegistry (with template variables from tenant context)
 * 3. Validate input content via Guardrails (pre-generation)
 * 4. Execute via Model Registry (select model, handle fallback if primary unavailable)
 * 5. Validate output content via Guardrails (post-generation)
 * 6. If guardrail violation → regenerate (up to max retries) or block
 * 7. Persist interaction to Agent Memory (short-term)
 * 8. Log execution to Observability (with trace_id, tokens, duration, status)
 * 9. Track token usage via Model Registry
 *
 * Requirements: 5.4, 9.7, 10.6, 11.3, 13.1, 13.9
 */
@Injectable()
export class AgentExecutionService implements IAgentExecutionService {
  private readonly logger = new Logger(AgentExecutionService.name);

  /** Maximum number of regeneration attempts when guardrails are violated. */
  private readonly MAX_REGENERATION_ATTEMPTS = 3;

  constructor(
    private readonly agentConfigService: AgentConfigService,
    private readonly promptRegistryService: PromptRegistryService,
    private readonly guardrailsService: GuardrailsService,
    private readonly agentMemoryService: AgentMemoryService,
    private readonly observabilityService: ObservabilityService,
    private readonly modelRegistryService: ModelRegistryService,
  ) {}

  /**
   * Execute the full agent pipeline end-to-end.
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
      // STEP 4: Select model (primary + fallback routing)
      // =====================================================================
      const { modelId, usedFallback } = await this.selectModel(
        agentConfig.modelId,
        agentConfig.fallbackModelId,
      );

      // =====================================================================
      // STEP 5 + 6: Generate output and validate via post-generation guardrails
      //             Regenerate on violation (up to max retries)
      // =====================================================================
      let generatedOutput = '';
      let finalTokens = { inputTokens: 0, outputTokens: 0 };
      let blocked = false;
      let blockedReason: string | undefined;

      for (let attempt = 1; attempt <= this.MAX_REGENERATION_ATTEMPTS; attempt++) {
        // Simulate LLM generation (in production, this calls the actual model API)
        const generationResult = await this.generateContent(
          modelId,
          resolvedPrompt,
          request.userInput,
          request.tenantId,
          request.agentId,
        );

        generatedOutput = generationResult.output;
        finalTokens = {
          inputTokens: finalTokens.inputTokens + generationResult.inputTokens,
          outputTokens: finalTokens.outputTokens + generationResult.outputTokens,
        };

        // Post-generation guardrail validation
        const postValidation = await this.guardrailsService.validateWithRegeneration(
          generatedOutput,
          request.tenantId,
          request.agentId,
          attempt,
        );

        if (postValidation.success) {
          // Content is valid — exit the loop
          break;
        }

        // Track violation names
        const violationNames = postValidation.violations.map((v) => v.guardrailName);
        guardrailViolations.push(...violationNames);

        if (postValidation.blocked) {
          blocked = true;
          blockedReason =
            'Generated content blocked after maximum regeneration attempts';
          generatedOutput = '';
          break;
        }

        // Otherwise, loop and regenerate
        this.logger.warn(
          `[${traceId}] Guardrail violation on attempt ${attempt}, regenerating...`,
        );
      }

      // =====================================================================
      // STEP 7: Persist interaction to Agent Memory (short-term)
      // =====================================================================
      await this.persistToMemory(
        request.agentId,
        request.tenantId,
        request.userInput,
        generatedOutput,
      );

      // =====================================================================
      // STEP 8: Log execution to Observability
      // =====================================================================
      const durationMs = Date.now() - startTime;
      const status = blocked ? 'error' : 'success';

      await this.logExecution(
        traceId,
        request,
        generatedOutput,
        durationMs,
        status,
        finalTokens,
        guardrailViolations,
        modelId,
      );

      // =====================================================================
      // STEP 9: Track token usage via Model Registry
      // =====================================================================
      await this.modelRegistryService.trackUsage(request.tenantId, modelId, {
        inputTokens: finalTokens.inputTokens,
        outputTokens: finalTokens.outputTokens,
        agentId: request.agentId,
        timestamp: new Date(),
      });

      return {
        success: !blocked,
        output: generatedOutput,
        traceId,
        modelId,
        usedFallback,
        tokensUsed: finalTokens,
        durationMs,
        blockedReason,
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
      // Try fetching all agents (the list method filters by tenant;
      // we need a different approach — use the repository directly via the config history)
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
   * Step 4: Select model with fallback routing.
   * Checks primary availability; if unavailable, routes to fallback.
   */
  private async selectModel(
    primaryModelId: string | null,
    fallbackModelId: string | null | undefined,
  ): Promise<{ modelId: string; usedFallback: boolean }> {
    if (!primaryModelId) {
      throw new ServiceUnavailableException(
        'No model configured for this agent',
      );
    }

    // Check primary model availability
    const health = await this.modelRegistryService.checkAvailability(primaryModelId);

    if (health.isAvailable) {
      return { modelId: primaryModelId, usedFallback: false };
    }

    // Primary unavailable — try configured fallback
    this.logger.warn(
      `Primary model ${primaryModelId} unavailable, attempting fallback...`,
    );

    if (fallbackModelId) {
      const fallbackHealth =
        await this.modelRegistryService.checkAvailability(fallbackModelId);
      if (fallbackHealth.isAvailable) {
        return { modelId: fallbackModelId, usedFallback: true };
      }
    }

    // Try automatic fallback from Model Registry
    const autoFallback =
      await this.modelRegistryService.getFallback(primaryModelId);
    if (autoFallback) {
      return { modelId: autoFallback.id, usedFallback: true };
    }

    throw new ServiceUnavailableException(
      'No available model (primary or fallback) for this agent',
    );
  }

  /**
   * Step 5: Generate content via model.
   * In production, this would call the actual LLM provider API.
   * For the MVP foundation, this is a stub that returns a placeholder.
   */
  private async generateContent(
    _modelId: string,
    _systemPrompt: string,
    _userInput: string,
    _tenantId: string,
    _agentId: string,
  ): Promise<{ output: string; inputTokens: number; outputTokens: number }> {
    // Stub: In production, this calls the LLM API via the model's provider.
    // The actual integration will be implemented in the AI Orchestration layer (LangGraph).
    return {
      output: `Generated response for input`,
      inputTokens: 150,
      outputTokens: 100,
    };
  }

  /**
   * Step 7: Persist both user input and assistant output to short-term memory.
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
   * Step 8: Log execution to Observability with trace_id.
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
