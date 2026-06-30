/**
 * Interface for the Fallback Handler that executes a simplified local pipeline
 * when the LangGraph Service is unavailable.
 *
 * Requirements: 2.2, 2.6
 */

import { ExecuteWorkflowRequest, ExecuteWorkflowResponse } from './grpc-types';

/**
 * Fallback Handler interface for degraded-mode execution.
 * Calls the LLM directly without routing through the LangGraph Service.
 * Must not produce side effects on the LangGraph Service or any state store.
 */
export interface IFallbackHandler {
  /**
   * Execute a simplified fallback pipeline bypassing the LangGraph Service.
   *
   * - Calls the LLM directly (simplified pipeline)
   * - Returns response with usedFallback=true
   * - Does NOT contact the LangGraph Service
   * - Does NOT write to any external state store
   *
   * @param request - The workflow execution request
   * @returns ExecuteWorkflowResponse with usedFallback=true
   */
  executeFallback(request: ExecuteWorkflowRequest): Promise<ExecuteWorkflowResponse>;
}

export const FALLBACK_HANDLER = Symbol('IFallbackHandler');
