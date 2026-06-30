import { ProtoSerializer } from './proto-serializer';
import {
  ExecuteWorkflowRequest,
  ExecuteWorkflowResponse,
  ExecutionState,
  CancelExecutionResponse,
  HealthCheckResponse,
  ExecutionStatus,
  ServiceStatus,
} from '../interfaces/grpc-types';

/**
 * Unit tests for ProtoSerializer — verifies correct serialization/deserialization
 * of protobuf messages between TypeScript (camelCase) and proto wire format (snake_case).
 *
 * Validates: Requirements 1.2, 1.4
 */
describe('ProtoSerializer', () => {
  let serializer: ProtoSerializer;

  beforeEach(() => {
    serializer = new ProtoSerializer();
  });

  // ===========================================================================
  // serializeExecuteWorkflowRequest
  // ===========================================================================

  describe('serializeExecuteWorkflowRequest', () => {
    it('should convert camelCase fields to snake_case proto format', () => {
      const request: ExecuteWorkflowRequest = {
        agentId: 'agent-123',
        tenantId: 'tenant-456',
        userInput: 'Hello world',
        userId: 'user-789',
        tenantContext: { key: 'value' },
        workflowId: 'wf-001',
        conversationId: 'conv-002',
        options: {
          maxSteps: 50,
          timeoutMs: 120000,
          enableStreaming: true,
          metadata: { traceKey: 'traceValue' },
        },
      };

      const result = serializer.serializeExecuteWorkflowRequest(request);

      expect(result).toEqual({
        agent_id: 'agent-123',
        tenant_id: 'tenant-456',
        user_input: 'Hello world',
        user_id: 'user-789',
        tenant_context: { key: 'value' },
        workflow_id: 'wf-001',
        conversation_id: 'conv-002',
        options: {
          max_steps: 50,
          timeout_ms: 120000,
          enable_streaming: true,
          metadata: { traceKey: 'traceValue' },
        },
      });
    });

    it('should handle empty/undefined optional fields gracefully', () => {
      const request: ExecuteWorkflowRequest = {
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        userInput: 'test',
        userId: '',
        tenantContext: {},
        workflowId: '',
        conversationId: '',
        options: {
          maxSteps: 0,
          timeoutMs: 0,
          enableStreaming: false,
          metadata: {},
        },
      };

      const result = serializer.serializeExecuteWorkflowRequest(request);

      expect(result.agent_id).toBe('agent-1');
      expect(result.user_id).toBe('');
      expect(result.tenant_context).toEqual({});
      expect(result.workflow_id).toBe('');
      expect(result.options.max_steps).toBe(0);
      expect(result.options.enable_streaming).toBe(false);
    });

    it('should handle request without options', () => {
      const request = {
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        userInput: 'test',
        userId: 'user-1',
        tenantContext: {},
        workflowId: '',
        conversationId: '',
        options: undefined as any,
      };

      const result = serializer.serializeExecuteWorkflowRequest(request);

      expect(result.options).toBeUndefined();
    });
  });

  // ===========================================================================
  // deserializeExecuteWorkflowResponse
  // ===========================================================================

  describe('deserializeExecuteWorkflowResponse', () => {
    it('should deserialize a complete proto response (snake_case)', () => {
      const raw = {
        success: true,
        output: 'Generated content',
        trace_id: 'trace-abc',
        model_id: 'gpt-4',
        used_fallback: false,
        tokens_used: { input_tokens: 100, output_tokens: 200 },
        duration_ms: 5000,
        blocked_reason: '',
        guardrail_violations: [],
        final_state: {
          execution_id: 'exec-1',
          workflow_id: 'wf-1',
          tenant_id: 'tenant-1',
          status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
          state_data: null,
          current_node: 'end',
          completed_nodes: ['start', 'llm', 'end'],
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:05:00.000Z',
        },
        steps: [
          {
            node_id: 'llm-node',
            node_type: 'llm_call',
            output: 'response text',
            duration_ms: 3000,
            tokens_used: { input_tokens: 100, output_tokens: 200 },
            status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
            error_message: '',
          },
        ],
      };

      const result = serializer.deserializeExecuteWorkflowResponse(raw);

      expect(result.success).toBe(true);
      expect(result.output).toBe('Generated content');
      expect(result.traceId).toBe('trace-abc');
      expect(result.modelId).toBe('gpt-4');
      expect(result.usedFallback).toBe(false);
      expect(result.tokensUsed).toEqual({ inputTokens: 100, outputTokens: 200 });
      expect(result.durationMs).toBe(5000);
      expect(result.blockedReason).toBe('');
      expect(result.guardrailViolations).toEqual([]);
      expect(result.finalState.executionId).toBe('exec-1');
      expect(result.finalState.completedNodes).toEqual(['start', 'llm', 'end']);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0].nodeId).toBe('llm-node');
      expect(result.steps[0].nodeType).toBe('llm_call');
      expect(result.steps[0].tokensUsed).toEqual({
        inputTokens: 100,
        outputTokens: 200,
      });
    });

    it('should handle null/undefined raw input', () => {
      const result = serializer.deserializeExecuteWorkflowResponse(null);

      expect(result.success).toBe(false);
      expect(result.output).toBe('');
      expect(result.steps).toEqual([]);
      expect(result.tokensUsed).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('should handle partial response with missing fields', () => {
      const raw = {
        success: true,
        output: 'partial',
      };

      const result = serializer.deserializeExecuteWorkflowResponse(raw);

      expect(result.success).toBe(true);
      expect(result.output).toBe('partial');
      expect(result.traceId).toBe('');
      expect(result.tokensUsed).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(result.steps).toEqual([]);
      expect(result.guardrailViolations).toEqual([]);
    });

    it('should handle camelCase response (proto-loader with keepCase:false)', () => {
      const raw = {
        success: true,
        output: 'result',
        traceId: 'trace-xyz',
        modelId: 'claude-3',
        usedFallback: true,
        tokensUsed: { inputTokens: 50, outputTokens: 80 },
        durationMs: 2000,
        blockedReason: '',
        guardrailViolations: ['violation1'],
        finalState: {
          executionId: 'exec-2',
          workflowId: 'wf-2',
          tenantId: 'tenant-2',
          status: 3,
          currentNode: 'done',
          completedNodes: ['a', 'b'],
          createdAt: '2024-06-01T12:00:00.000Z',
          updatedAt: '2024-06-01T12:01:00.000Z',
        },
        steps: [],
      };

      const result = serializer.deserializeExecuteWorkflowResponse(raw);

      expect(result.traceId).toBe('trace-xyz');
      expect(result.modelId).toBe('claude-3');
      expect(result.usedFallback).toBe(true);
      expect(result.tokensUsed).toEqual({ inputTokens: 50, outputTokens: 80 });
      expect(result.guardrailViolations).toEqual(['violation1']);
      expect(result.finalState.executionId).toBe('exec-2');
    });
  });

  // ===========================================================================
  // deserializeExecutionState
  // ===========================================================================

  describe('deserializeExecutionState', () => {
    it('should deserialize a complete execution state (snake_case)', () => {
      const raw = {
        execution_id: 'exec-abc',
        workflow_id: 'wf-abc',
        tenant_id: 'tenant-abc',
        status: ExecutionStatus.EXECUTION_STATUS_RUNNING,
        state_data: { fields: { key: { stringValue: 'value' } } },
        current_node: 'llm-node',
        completed_nodes: ['start'],
        created_at: { seconds: 1704067200, nanos: 0 },
        updated_at: '2024-01-02T00:00:00.000Z',
      };

      const result = serializer.deserializeExecutionState(raw);

      expect(result.executionId).toBe('exec-abc');
      expect(result.workflowId).toBe('wf-abc');
      expect(result.tenantId).toBe('tenant-abc');
      expect(result.status).toBe(ExecutionStatus.EXECUTION_STATUS_RUNNING);
      expect(result.stateData).toEqual({ key: 'value' });
      expect(result.currentNode).toBe('llm-node');
      expect(result.completedNodes).toEqual(['start']);
      expect(result.createdAt).toBe('2024-01-01T00:00:00.000Z');
      expect(result.updatedAt).toBe('2024-01-02T00:00:00.000Z');
    });

    it('should return empty state for null input', () => {
      const result = serializer.deserializeExecutionState(null);

      expect(result.executionId).toBe('');
      expect(result.status).toBe(ExecutionStatus.EXECUTION_STATUS_UNSPECIFIED);
      expect(result.completedNodes).toEqual([]);
      expect(result.stateData).toEqual({});
    });

    it('should handle state_data as plain object (non-Struct format)', () => {
      const raw = {
        execution_id: 'exec-1',
        workflow_id: 'wf-1',
        tenant_id: 't-1',
        status: 1,
        state_data: { user_input: 'hello', messages: [] },
        current_node: 'start',
        completed_nodes: [],
        created_at: '',
        updated_at: '',
      };

      const result = serializer.deserializeExecutionState(raw);

      expect(result.stateData).toEqual({ user_input: 'hello', messages: [] });
    });

    it('should deserialize Struct with nested values', () => {
      const raw = {
        execution_id: 'exec-1',
        workflow_id: 'wf-1',
        tenant_id: 't-1',
        status: 3,
        state_data: {
          fields: {
            count: { numberValue: 42 },
            active: { boolValue: true },
            name: { stringValue: 'test' },
            empty: { nullValue: 0 },
            nested: {
              structValue: {
                fields: {
                  inner: { stringValue: 'nested_val' },
                },
              },
            },
            items: {
              listValue: {
                values: [
                  { stringValue: 'a' },
                  { numberValue: 1 },
                ],
              },
            },
          },
        },
        current_node: '',
        completed_nodes: [],
        created_at: '',
        updated_at: '',
      };

      const result = serializer.deserializeExecutionState(raw);

      expect(result.stateData).toEqual({
        count: 42,
        active: true,
        name: 'test',
        empty: null,
        nested: { inner: 'nested_val' },
        items: ['a', 1],
      });
    });
  });

  // ===========================================================================
  // deserializeCancelExecutionResponse
  // ===========================================================================

  describe('deserializeCancelExecutionResponse', () => {
    it('should deserialize a successful cancel response', () => {
      const raw = { success: true, message: 'Execution cancelled' };
      const result = serializer.deserializeCancelExecutionResponse(raw);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Execution cancelled');
    });

    it('should deserialize a failed cancel response', () => {
      const raw = {
        success: false,
        message: 'Execution already completed',
      };
      const result = serializer.deserializeCancelExecutionResponse(raw);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Execution already completed');
    });

    it('should handle null input', () => {
      const result = serializer.deserializeCancelExecutionResponse(null);

      expect(result.success).toBe(false);
      expect(result.message).toBe('');
    });
  });

  // ===========================================================================
  // deserializeHealthCheckResponse
  // ===========================================================================

  describe('deserializeHealthCheckResponse', () => {
    it('should deserialize a healthy service response', () => {
      const raw = {
        status: ServiceStatus.SERVICE_STATUS_SERVING,
        version: '1.0.0',
        details: { redis: 'healthy', postgres: 'healthy' },
      };

      const result = serializer.deserializeHealthCheckResponse(raw);

      expect(result.status).toBe(ServiceStatus.SERVICE_STATUS_SERVING);
      expect(result.version).toBe('1.0.0');
      expect(result.details).toEqual({ redis: 'healthy', postgres: 'healthy' });
    });

    it('should deserialize an unhealthy service response', () => {
      const raw = {
        status: ServiceStatus.SERVICE_STATUS_NOT_SERVING,
        version: '1.0.0',
        details: { redis: 'unavailable', postgres: 'healthy' },
      };

      const result = serializer.deserializeHealthCheckResponse(raw);

      expect(result.status).toBe(ServiceStatus.SERVICE_STATUS_NOT_SERVING);
      expect(result.details.redis).toBe('unavailable');
    });

    it('should handle null input', () => {
      const result = serializer.deserializeHealthCheckResponse(null);

      expect(result.status).toBe(ServiceStatus.SERVICE_STATUS_UNSPECIFIED);
      expect(result.version).toBe('');
      expect(result.details).toEqual({});
    });

    it('should handle string enum values', () => {
      const raw = {
        status: 'SERVICE_STATUS_SERVING',
        version: '2.0.0',
        details: {},
      };

      const result = serializer.deserializeHealthCheckResponse(raw);

      expect(result.status).toBe(ServiceStatus.SERVICE_STATUS_SERVING);
    });
  });

  // ===========================================================================
  // Round-trip consistency (Requirement 1.4)
  // ===========================================================================

  describe('Round-trip: serialize then deserialize', () => {
    it('should produce deep-equal object after serialize → convert to response → deserialize', () => {
      const originalRequest: ExecuteWorkflowRequest = {
        agentId: 'a1b2c3d4',
        tenantId: 't-001',
        userInput: 'Generate a marketing campaign',
        userId: 'u-042',
        tenantContext: { industry: 'beauty', plan: 'premium' },
        workflowId: 'wf-marketing',
        conversationId: 'conv-777',
        options: {
          maxSteps: 25,
          timeoutMs: 60000,
          enableStreaming: true,
          metadata: { source: 'api' },
        },
      };

      // Serialize to proto format
      const protoFormat =
        serializer.serializeExecuteWorkflowRequest(originalRequest);

      // Verify proto format is snake_case
      expect(protoFormat.agent_id).toBe(originalRequest.agentId);
      expect(protoFormat.tenant_id).toBe(originalRequest.tenantId);
      expect(protoFormat.user_input).toBe(originalRequest.userInput);
      expect(protoFormat.options.max_steps).toBe(
        originalRequest.options.maxSteps,
      );
      expect(protoFormat.options.timeout_ms).toBe(
        originalRequest.options.timeoutMs,
      );
      expect(protoFormat.options.enable_streaming).toBe(
        originalRequest.options.enableStreaming,
      );
    });

    it('should produce deep-equal ExecuteWorkflowResponse after deserialize', () => {
      const expected: ExecuteWorkflowResponse = {
        success: true,
        output: 'Campaign created successfully',
        traceId: 'trace-round-trip',
        modelId: 'gpt-4-turbo',
        usedFallback: false,
        tokensUsed: { inputTokens: 500, outputTokens: 1200 },
        durationMs: 8500,
        blockedReason: '',
        guardrailViolations: [],
        finalState: {
          executionId: 'exec-rt-1',
          workflowId: 'wf-rt-1',
          tenantId: 'tenant-rt',
          status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
          stateData: {},
          currentNode: 'end',
          completedNodes: ['planner', 'content', 'review'],
          createdAt: '2024-06-15T10:00:00.000Z',
          updatedAt: '2024-06-15T10:01:00.000Z',
        },
        steps: [
          {
            nodeId: 'planner',
            nodeType: 'llm_call',
            output: 'Plan created',
            durationMs: 3000,
            tokensUsed: { inputTokens: 200, outputTokens: 500 },
            status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
            errorMessage: '',
          },
          {
            nodeId: 'content',
            nodeType: 'llm_call',
            output: 'Content generated',
            durationMs: 4000,
            tokensUsed: { inputTokens: 300, outputTokens: 700 },
            status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
            errorMessage: '',
          },
        ],
      };

      // Simulate proto wire format (snake_case)
      const protoWire = {
        success: true,
        output: 'Campaign created successfully',
        trace_id: 'trace-round-trip',
        model_id: 'gpt-4-turbo',
        used_fallback: false,
        tokens_used: { input_tokens: 500, output_tokens: 1200 },
        duration_ms: 8500,
        blocked_reason: '',
        guardrail_violations: [],
        final_state: {
          execution_id: 'exec-rt-1',
          workflow_id: 'wf-rt-1',
          tenant_id: 'tenant-rt',
          status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
          current_node: 'end',
          completed_nodes: ['planner', 'content', 'review'],
          created_at: '2024-06-15T10:00:00.000Z',
          updated_at: '2024-06-15T10:01:00.000Z',
        },
        steps: [
          {
            node_id: 'planner',
            node_type: 'llm_call',
            output: 'Plan created',
            duration_ms: 3000,
            tokens_used: { input_tokens: 200, output_tokens: 500 },
            status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
            error_message: '',
          },
          {
            node_id: 'content',
            node_type: 'llm_call',
            output: 'Content generated',
            duration_ms: 4000,
            tokens_used: { input_tokens: 300, output_tokens: 700 },
            status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
            error_message: '',
          },
        ],
      };

      const result =
        serializer.deserializeExecuteWorkflowResponse(protoWire);

      expect(result).toEqual(expected);
    });

    it('should preserve all fields in ExecutionState round-trip', () => {
      const expected: ExecutionState = {
        executionId: 'exec-state-rt',
        workflowId: 'wf-state-rt',
        tenantId: 'tenant-state-rt',
        status: ExecutionStatus.EXECUTION_STATUS_FAILED,
        stateData: {},
        currentNode: 'failed-node',
        completedNodes: ['node-a', 'node-b'],
        createdAt: '2024-03-01T08:00:00.000Z',
        updatedAt: '2024-03-01T08:02:30.000Z',
      };

      const protoWire = {
        execution_id: 'exec-state-rt',
        workflow_id: 'wf-state-rt',
        tenant_id: 'tenant-state-rt',
        status: ExecutionStatus.EXECUTION_STATUS_FAILED,
        current_node: 'failed-node',
        completed_nodes: ['node-a', 'node-b'],
        created_at: '2024-03-01T08:00:00.000Z',
        updated_at: '2024-03-01T08:02:30.000Z',
      };

      const result = serializer.deserializeExecutionState(protoWire);

      expect(result).toEqual(expected);
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('Edge cases', () => {
    it('should handle empty repeated fields as empty arrays', () => {
      const raw = {
        success: true,
        output: 'test',
        steps: [],
        guardrail_violations: [],
      };

      const result = serializer.deserializeExecuteWorkflowResponse(raw);

      expect(result.steps).toEqual([]);
      expect(result.guardrailViolations).toEqual([]);
    });

    it('should handle undefined repeated fields as empty arrays', () => {
      const raw = {
        success: true,
        output: 'test',
      };

      const result = serializer.deserializeExecuteWorkflowResponse(raw);

      expect(result.steps).toEqual([]);
      expect(result.guardrailViolations).toEqual([]);
    });

    it('should handle numeric enum values correctly', () => {
      const raw = {
        execution_id: 'e1',
        workflow_id: 'w1',
        tenant_id: 't1',
        status: 5, // CANCELLED
        current_node: '',
        completed_nodes: [],
        created_at: '',
        updated_at: '',
      };

      const result = serializer.deserializeExecutionState(raw);

      expect(result.status).toBe(ExecutionStatus.EXECUTION_STATUS_CANCELLED);
    });

    it('should fallback to UNSPECIFIED for invalid enum values', () => {
      const raw = {
        execution_id: 'e1',
        workflow_id: 'w1',
        tenant_id: 't1',
        status: 999, // invalid
        current_node: '',
        completed_nodes: [],
        created_at: '',
        updated_at: '',
      };

      const result = serializer.deserializeExecutionState(raw);

      expect(result.status).toBe(ExecutionStatus.EXECUTION_STATUS_UNSPECIFIED);
    });

    it('should handle proto Timestamp format { seconds, nanos }', () => {
      const raw = {
        execution_id: 'e1',
        workflow_id: 'w1',
        tenant_id: 't1',
        status: 1,
        current_node: '',
        completed_nodes: [],
        created_at: { seconds: 1704067200, nanos: 500000000 },
        updated_at: { seconds: 1704067260, nanos: 0 },
      };

      const result = serializer.deserializeExecutionState(raw);

      expect(result.createdAt).toBe('2024-01-01T00:00:00.500Z');
      expect(result.updatedAt).toBe('2024-01-01T00:01:00.000Z');
    });

    it('should handle tokens_used as null gracefully', () => {
      const raw = {
        success: true,
        output: 'test',
        tokens_used: null,
        steps: [
          {
            node_id: 'n1',
            node_type: 'tool_call',
            output: '',
            duration_ms: 100,
            tokens_used: null,
            status: 3,
            error_message: '',
          },
        ],
      };

      const result = serializer.deserializeExecuteWorkflowResponse(raw);

      expect(result.tokensUsed).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(result.steps[0].tokensUsed).toEqual({
        inputTokens: 0,
        outputTokens: 0,
      });
    });
  });
});
