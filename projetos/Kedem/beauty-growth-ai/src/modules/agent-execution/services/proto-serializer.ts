import {
  ExecuteWorkflowRequest,
  ExecuteWorkflowResponse,
  ExecutionState,
  CancelExecutionResponse,
  HealthCheckResponse,
  ExecutionStatus,
  ServiceStatus,
  TokenUsage,
  StepResult,
  ExecutionOptions,
} from '../interfaces/grpc-types';

/**
 * ProtoSerializer handles conversion between TypeScript (camelCase) objects
 * and protobuf wire format (snake_case) for the AgentOrchestrationService.
 *
 * Responsibilities:
 * - Serialize TypeScript request objects to proto-compatible format
 * - Deserialize raw proto response objects to TypeScript interfaces
 * - Handle edge cases: null/undefined fields, empty arrays, enum conversion
 *
 * Requirements: 1.2, 1.4
 */
export class ProtoSerializer {
  // ===========================================================================
  // SERIALIZATION (TypeScript → Proto wire format)
  // ===========================================================================

  /**
   * Serialize an ExecuteWorkflowRequest to proto wire format (snake_case).
   */
  serializeExecuteWorkflowRequest(
    request: ExecuteWorkflowRequest,
  ): Record<string, any> {
    return {
      agent_id: request.agentId || '',
      tenant_id: request.tenantId || '',
      user_input: request.userInput || '',
      user_id: request.userId || '',
      tenant_context: request.tenantContext || {},
      workflow_id: request.workflowId || '',
      conversation_id: request.conversationId || '',
      options: request.options
        ? this.serializeExecutionOptions(request.options)
        : undefined,
    };
  }

  /**
   * Serialize ExecutionOptions to proto wire format.
   */
  private serializeExecutionOptions(
    options: ExecutionOptions,
  ): Record<string, any> {
    return {
      max_steps: options.maxSteps ?? 0,
      timeout_ms: options.timeoutMs ?? 0,
      enable_streaming: options.enableStreaming ?? false,
      metadata: options.metadata || {},
    };
  }

  // ===========================================================================
  // DESERIALIZATION (Proto wire format → TypeScript)
  // ===========================================================================

  /**
   * Deserialize a raw proto ExecuteWorkflowResponse to TypeScript interface.
   */
  deserializeExecuteWorkflowResponse(raw: any): ExecuteWorkflowResponse {
    if (!raw) {
      return this.emptyExecuteWorkflowResponse();
    }

    return {
      success: Boolean(raw.success),
      output: raw.output || '',
      traceId: raw.trace_id || raw.traceId || '',
      modelId: raw.model_id || raw.modelId || '',
      usedFallback: Boolean(raw.used_fallback ?? raw.usedFallback),
      tokensUsed: this.deserializeTokenUsage(
        raw.tokens_used || raw.tokensUsed,
      ),
      durationMs: Number(raw.duration_ms ?? raw.durationMs ?? 0),
      blockedReason: raw.blocked_reason || raw.blockedReason || '',
      guardrailViolations: this.deserializeStringArray(
        raw.guardrail_violations || raw.guardrailViolations,
      ),
      finalState: this.deserializeExecutionState(
        raw.final_state || raw.finalState,
      ),
      steps: this.deserializeStepResults(raw.steps),
    };
  }

  /**
   * Deserialize a raw proto ExecutionState to TypeScript interface.
   */
  deserializeExecutionState(raw: any): ExecutionState {
    if (!raw) {
      return this.emptyExecutionState();
    }

    return {
      executionId: raw.execution_id || raw.executionId || '',
      workflowId: raw.workflow_id || raw.workflowId || '',
      tenantId: raw.tenant_id || raw.tenantId || '',
      status: this.deserializeExecutionStatus(raw.status),
      stateData: this.deserializeStruct(raw.state_data || raw.stateData),
      currentNode: raw.current_node || raw.currentNode || '',
      completedNodes: this.deserializeStringArray(
        raw.completed_nodes || raw.completedNodes,
      ),
      createdAt: this.deserializeTimestamp(raw.created_at || raw.createdAt),
      updatedAt: this.deserializeTimestamp(raw.updated_at || raw.updatedAt),
    };
  }

  /**
   * Deserialize a raw proto CancelExecutionResponse to TypeScript interface.
   */
  deserializeCancelExecutionResponse(raw: any): CancelExecutionResponse {
    if (!raw) {
      return { success: false, message: '' };
    }

    return {
      success: Boolean(raw.success),
      message: raw.message || '',
    };
  }

  /**
   * Deserialize a raw proto HealthCheckResponse to TypeScript interface.
   */
  deserializeHealthCheckResponse(raw: any): HealthCheckResponse {
    if (!raw) {
      return {
        status: ServiceStatus.SERVICE_STATUS_UNSPECIFIED,
        version: '',
        details: {},
      };
    }

    return {
      status: this.deserializeServiceStatus(raw.status),
      version: raw.version || '',
      details: this.deserializeStringMap(raw.details),
    };
  }

  // ===========================================================================
  // HELPER METHODS
  // ===========================================================================

  /**
   * Deserialize a single StepResult from proto format.
   */
  private deserializeStepResult(raw: any): StepResult {
    if (!raw) {
      return this.emptyStepResult();
    }

    return {
      nodeId: raw.node_id || raw.nodeId || '',
      nodeType: raw.node_type || raw.nodeType || '',
      output: raw.output || '',
      durationMs: Number(raw.duration_ms ?? raw.durationMs ?? 0),
      tokensUsed: this.deserializeTokenUsage(
        raw.tokens_used || raw.tokensUsed,
      ),
      status: this.deserializeExecutionStatus(raw.status),
      errorMessage: raw.error_message || raw.errorMessage || '',
    };
  }

  /**
   * Deserialize an array of StepResult objects.
   */
  private deserializeStepResults(raw: any): StepResult[] {
    if (!raw || !Array.isArray(raw)) {
      return [];
    }
    return raw.map((item: any) => this.deserializeStepResult(item));
  }

  /**
   * Deserialize TokenUsage from proto format.
   */
  private deserializeTokenUsage(raw: any): TokenUsage {
    if (!raw) {
      return { inputTokens: 0, outputTokens: 0 };
    }

    return {
      inputTokens: Number(raw.input_tokens ?? raw.inputTokens ?? 0),
      outputTokens: Number(raw.output_tokens ?? raw.outputTokens ?? 0),
    };
  }

  /**
   * Deserialize an ExecutionStatus enum value.
   * Handles both numeric and string enum representations.
   */
  private deserializeExecutionStatus(raw: any): ExecutionStatus {
    if (raw === undefined || raw === null) {
      return ExecutionStatus.EXECUTION_STATUS_UNSPECIFIED;
    }

    if (typeof raw === 'number') {
      // Validate the number is a known enum value
      if (Object.values(ExecutionStatus).includes(raw)) {
        return raw as ExecutionStatus;
      }
      return ExecutionStatus.EXECUTION_STATUS_UNSPECIFIED;
    }

    if (typeof raw === 'string') {
      // Handle string enum names (e.g., "EXECUTION_STATUS_COMPLETED")
      const enumValue =
        ExecutionStatus[raw as keyof typeof ExecutionStatus];
      if (enumValue !== undefined) {
        return enumValue;
      }
      return ExecutionStatus.EXECUTION_STATUS_UNSPECIFIED;
    }

    return ExecutionStatus.EXECUTION_STATUS_UNSPECIFIED;
  }

  /**
   * Deserialize a ServiceStatus enum value.
   */
  private deserializeServiceStatus(raw: any): ServiceStatus {
    if (raw === undefined || raw === null) {
      return ServiceStatus.SERVICE_STATUS_UNSPECIFIED;
    }

    if (typeof raw === 'number') {
      if (Object.values(ServiceStatus).includes(raw)) {
        return raw as ServiceStatus;
      }
      return ServiceStatus.SERVICE_STATUS_UNSPECIFIED;
    }

    if (typeof raw === 'string') {
      const enumValue =
        ServiceStatus[raw as keyof typeof ServiceStatus];
      if (enumValue !== undefined) {
        return enumValue;
      }
      return ServiceStatus.SERVICE_STATUS_UNSPECIFIED;
    }

    return ServiceStatus.SERVICE_STATUS_UNSPECIFIED;
  }

  /**
   * Deserialize a google.protobuf.Struct into a plain JS object.
   * Proto Struct uses a specific format: { fields: { key: { kind: value } } }
   */
  private deserializeStruct(raw: any): Record<string, unknown> {
    if (!raw) return {};

    // If it's already a plain object (e.g., when keepCase: false converts it)
    if (typeof raw === 'object' && !raw.fields) {
      return raw as Record<string, unknown>;
    }

    // Handle proto Struct format
    if (raw.fields) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw.fields)) {
        result[key] = this.deserializeStructValue(value);
      }
      return result;
    }

    return {};
  }

  /**
   * Deserialize a single google.protobuf.Value.
   */
  private deserializeStructValue(value: any): unknown {
    if (!value) return null;

    if ('nullValue' in value || 'null_value' in value) return null;
    if ('numberValue' in value || 'number_value' in value)
      return value.numberValue ?? value.number_value;
    if ('stringValue' in value || 'string_value' in value)
      return value.stringValue ?? value.string_value;
    if ('boolValue' in value || 'bool_value' in value)
      return value.boolValue ?? value.bool_value;
    if ('structValue' in value || 'struct_value' in value)
      return this.deserializeStruct(value.structValue ?? value.struct_value);
    if ('listValue' in value || 'list_value' in value) {
      const list = value.listValue ?? value.list_value;
      if (list && list.values) {
        return list.values.map((v: any) => this.deserializeStructValue(v));
      }
      return [];
    }

    return null;
  }

  /**
   * Deserialize a protobuf Timestamp to ISO string.
   */
  private deserializeTimestamp(raw: any): string {
    if (!raw) return '';

    // If already a string (ISO format), return as-is
    if (typeof raw === 'string') return raw;

    // Handle proto Timestamp format { seconds, nanos }
    if (raw.seconds !== undefined) {
      const ms =
        Number(raw.seconds) * 1000 + Math.floor((raw.nanos || 0) / 1_000_000);
      return new Date(ms).toISOString();
    }

    return '';
  }

  /**
   * Deserialize a string array, handling null/undefined.
   */
  private deserializeStringArray(raw: any): string[] {
    if (!raw || !Array.isArray(raw)) return [];
    return raw.map((item: any) => String(item || ''));
  }

  /**
   * Deserialize a map<string, string>, handling null/undefined.
   */
  private deserializeStringMap(raw: any): Record<string, string> {
    if (!raw || typeof raw !== 'object') return {};

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      result[key] = String(value || '');
    }
    return result;
  }

  // ===========================================================================
  // EMPTY OBJECT FACTORIES
  // ===========================================================================

  private emptyExecuteWorkflowResponse(): ExecuteWorkflowResponse {
    return {
      success: false,
      output: '',
      traceId: '',
      modelId: '',
      usedFallback: false,
      tokensUsed: { inputTokens: 0, outputTokens: 0 },
      durationMs: 0,
      blockedReason: '',
      guardrailViolations: [],
      finalState: this.emptyExecutionState(),
      steps: [],
    };
  }

  private emptyExecutionState(): ExecutionState {
    return {
      executionId: '',
      workflowId: '',
      tenantId: '',
      status: ExecutionStatus.EXECUTION_STATUS_UNSPECIFIED,
      stateData: {},
      currentNode: '',
      completedNodes: [],
      createdAt: '',
      updatedAt: '',
    };
  }

  private emptyStepResult(): StepResult {
    return {
      nodeId: '',
      nodeType: '',
      output: '',
      durationMs: 0,
      tokensUsed: { inputTokens: 0, outputTokens: 0 },
      status: ExecutionStatus.EXECUTION_STATUS_UNSPECIFIED,
      errorMessage: '',
    };
  }
}
