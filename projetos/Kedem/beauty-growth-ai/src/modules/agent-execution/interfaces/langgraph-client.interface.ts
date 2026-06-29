/**
 * Interface for the LangGraph gRPC client.
 * Defines the contract for communication between NestJS and the LangGraph Python service.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.5, 1.7
 */

import {
  ExecuteWorkflowRequest,
  ExecuteWorkflowResponse,
  ExecutionState,
  CancelExecutionResponse,
  HealthCheckResponse,
  WorkflowStreamEvent,
} from './grpc-types';

export interface ILangGraphClient {
  /**
   * Execute a complete agent workflow via gRPC.
   * Propagates tenant_id, trace_id, and user_id as gRPC metadata.
   * Enforces 30s timeout per call.
   */
  executeWorkflow(request: ExecuteWorkflowRequest): Promise<ExecuteWorkflowResponse>;

  /**
   * Execute a workflow with streaming of partial results.
   * Returns an async iterable of WorkflowStreamEvent.
   */
  executeWorkflowStream(request: ExecuteWorkflowRequest): AsyncIterable<WorkflowStreamEvent>;

  /**
   * Query the state of an ongoing or completed execution.
   */
  getExecutionState(executionId: string, tenantId: string): Promise<ExecutionState>;

  /**
   * Cancel an in-progress execution.
   */
  cancelExecution(executionId: string, tenantId: string): Promise<CancelExecutionResponse>;

  /**
   * Health check for the LangGraph service.
   */
  healthCheck(): Promise<HealthCheckResponse>;
}

export const LANGGRAPH_CLIENT = Symbol('ILangGraphClient');
