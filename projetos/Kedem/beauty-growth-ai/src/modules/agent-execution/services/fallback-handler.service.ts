import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IFallbackHandler } from '../interfaces/fallback-handler.interface';
import {
  ExecuteWorkflowRequest,
  ExecuteWorkflowResponse,
  ExecutionStatus,
} from '../interfaces/grpc-types';

/**
 * Fallback Handler Service for executing a simplified local pipeline
 * when the LangGraph Service is unavailable (circuit breaker OPEN).
 *
 * This service:
 * - Calls the LLM directly (MVP: simulated response)
 * - Returns response with usedFallback=true
 * - Does NOT contact the LangGraph Service
 * - Does NOT write to any state store (no side effects)
 *
 * Requirements: 2.2, 2.6
 */
@Injectable()
export class FallbackHandlerService implements IFallbackHandler {
  /**
   * Execute the fallback pipeline bypassing the LangGraph Service.
   *
   * In production, this would call OpenAI/Anthropic directly.
   * For MVP, it simulates a direct LLM response.
   */
  async executeFallback(
    request: ExecuteWorkflowRequest,
  ): Promise<ExecuteWorkflowResponse> {
    const traceId = randomUUID();
    const startTime = Date.now();

    // Simulate direct LLM call (MVP placeholder)
    // In production: call OpenAI/Anthropic SDK directly without LangGraph
    const llmResponse = await this.callLlmDirect(request.userInput);

    const durationMs = Date.now() - startTime;

    return {
      success: true,
      output: llmResponse,
      traceId,
      modelId: 'fallback-direct',
      usedFallback: true,
      tokensUsed: { inputTokens: 0, outputTokens: 0 },
      durationMs,
      blockedReason: '',
      guardrailViolations: [],
      finalState: {
        executionId: traceId,
        workflowId: '',
        tenantId: request.tenantId,
        status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
        stateData: {},
        currentNode: '',
        completedNodes: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      steps: [],
    };
  }

  /**
   * Direct LLM call bypassing the LangGraph workflow engine.
   *
   * MVP: Returns a simulated response.
   * Production: Would use OpenAI/Anthropic SDK directly.
   */
  private async callLlmDirect(userInput: string): Promise<string> {
    // MVP placeholder - simulates a direct LLM response
    // No external calls, no side effects
    return `[Fallback Mode] Resposta direta para: "${userInput}". O serviço principal está temporariamente indisponível. Esta resposta foi gerada em modo degradado sem o pipeline completo de agentes.`;
  }
}
