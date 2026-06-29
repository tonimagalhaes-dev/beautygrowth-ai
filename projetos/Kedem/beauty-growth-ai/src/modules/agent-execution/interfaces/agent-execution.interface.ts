/**
 * Agent Execution Service interfaces.
 * Orchestrates the full agent execution pipeline:
 * config → prompt resolution → guardrails → model execution → memory → observability
 */

/**
 * Input for an agent execution request.
 */
export interface AgentExecutionRequest {
  /** The agent configuration ID to execute. */
  agentId: string;
  /** The tenant context. */
  tenantId: string;
  /** The user input/prompt. */
  userInput: string;
  /** Optional user ID making the request. */
  userId?: string;
  /** Optional tenant context variables for prompt template resolution. */
  tenantContext?: Record<string, string>;
}

/**
 * Result of a successful agent execution.
 */
export interface AgentExecutionResult {
  /** Whether the execution was successful. */
  success: boolean;
  /** The generated output (if success). */
  output: string;
  /** The trace ID for end-to-end correlation. */
  traceId: string;
  /** The model used for generation. */
  modelId: string;
  /** Whether a fallback model was used. */
  usedFallback: boolean;
  /** Token usage for this execution. */
  tokensUsed: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Execution duration in milliseconds. */
  durationMs: number;
  /** If blocked by guardrails, details here. */
  blockedReason?: string;
  /** Any guardrail violations encountered (regeneration attempts). */
  guardrailViolations?: string[];
}

/**
 * Interface for the AgentExecutionService.
 */
export interface IAgentExecutionService {
  /**
   * Execute the full agent pipeline.
   */
  execute(request: AgentExecutionRequest): Promise<AgentExecutionResult>;
}
