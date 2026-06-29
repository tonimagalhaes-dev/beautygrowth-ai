/**
 * TypeScript interfaces matching the protobuf messages defined in
 * proto/agent_orchestration.proto for the AgentOrchestrationService.
 *
 * These types represent the gRPC message structures used in communication
 * between the NestJS gateway and the LangGraph Python service.
 */

// ============================================================
// Enums
// ============================================================

export enum ExecutionStatus {
  EXECUTION_STATUS_UNSPECIFIED = 0,
  EXECUTION_STATUS_PENDING = 1,
  EXECUTION_STATUS_RUNNING = 2,
  EXECUTION_STATUS_COMPLETED = 3,
  EXECUTION_STATUS_FAILED = 4,
  EXECUTION_STATUS_CANCELLED = 5,
  EXECUTION_STATUS_TIMEOUT = 6,
}

export enum ServiceStatus {
  SERVICE_STATUS_UNSPECIFIED = 0,
  SERVICE_STATUS_SERVING = 1,
  SERVICE_STATUS_NOT_SERVING = 2,
}

// ============================================================
// Request / Response Messages
// ============================================================

export interface ExecutionOptions {
  /** Limite de passos no grafo */
  maxSteps: number;
  /** Timeout da execução em ms */
  timeoutMs: number;
  /** Habilitar eventos parciais */
  enableStreaming: boolean;
  /** Metadata adicional para tracing */
  metadata: Record<string, string>;
}

export interface ExecuteWorkflowRequest {
  agentId: string;
  tenantId: string;
  userInput: string;
  userId: string;
  tenantContext: Record<string, string>;
  /** Opcional: ID de workflow específico (para multi-agente) */
  workflowId: string;
  /** Para manter contexto conversacional */
  conversationId: string;
  options: ExecutionOptions;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface StepResult {
  nodeId: string;
  /** "agent", "tool", "condition", "parallel" */
  nodeType: string;
  output: string;
  durationMs: number;
  tokensUsed: TokenUsage;
  status: ExecutionStatus;
  errorMessage: string;
}

export interface ExecutionState {
  executionId: string;
  workflowId: string;
  tenantId: string;
  status: ExecutionStatus;
  /** Estado do LangGraph serializado */
  stateData: Record<string, unknown>;
  currentNode: string;
  completedNodes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ExecuteWorkflowResponse {
  success: boolean;
  output: string;
  traceId: string;
  modelId: string;
  usedFallback: boolean;
  tokensUsed: TokenUsage;
  durationMs: number;
  blockedReason: string;
  guardrailViolations: string[];
  finalState: ExecutionState;
  /** Detalhes de cada passo executado */
  steps: StepResult[];
}

// ============================================================
// Streaming Messages
// ============================================================

export interface StepStarted {
  nodeId: string;
  nodeType: string;
}

export interface StepCompleted {
  result: StepResult;
}

export interface TokenGenerated {
  token: string;
  nodeId: string;
}

export interface WorkflowCompleted {
  response: ExecuteWorkflowResponse;
}

export interface WorkflowError {
  errorCode: string;
  errorMessage: string;
  nodeId: string;
}

export interface WorkflowStreamEvent {
  stepStarted?: StepStarted;
  stepCompleted?: StepCompleted;
  tokenGenerated?: TokenGenerated;
  workflowCompleted?: WorkflowCompleted;
  workflowError?: WorkflowError;
}

// ============================================================
// Health Check Messages
// ============================================================

export interface HealthCheckResponse {
  status: ServiceStatus;
  version: string;
  details: Record<string, string>;
}

// ============================================================
// Cancellation Messages
// ============================================================

export interface CancelExecutionResponse {
  success: boolean;
  message: string;
}

// ============================================================
// gRPC Error Types
// ============================================================

/**
 * Typed gRPC error returned by the client when a call fails.
 * Requirements: 1.6
 */
export interface GrpcError {
  /** gRPC status code (e.g., UNAVAILABLE, DEADLINE_EXCEEDED) */
  code: number;
  /** Human-readable error message */
  message: string;
  /** trace_id from the original call for correlation */
  traceId: string;
}
