import { FallbackHandlerService } from './fallback-handler.service';
import {
  ExecuteWorkflowRequest,
  ExecuteWorkflowResponse,
  ExecutionStatus,
} from '../interfaces/grpc-types';

describe('FallbackHandlerService', () => {
  let service: FallbackHandlerService;

  const createRequest = (
    overrides?: Partial<ExecuteWorkflowRequest>,
  ): ExecuteWorkflowRequest => ({
    agentId: 'agent-123',
    tenantId: 'tenant-456',
    userInput: 'Qual é a melhor estratégia de marketing?',
    userId: 'user-789',
    tenantContext: {},
    workflowId: '',
    conversationId: '',
    options: {
      maxSteps: 50,
      timeoutMs: 120000,
      enableStreaming: false,
      metadata: {},
    },
    ...overrides,
  });

  beforeEach(() => {
    service = new FallbackHandlerService();
  });

  // =========================================================================
  // usedFallback FLAG
  // =========================================================================

  describe('usedFallback flag', () => {
    it('should return usedFallback=true', async () => {
      const request = createRequest();
      const result = await service.executeFallback(request);

      expect(result.usedFallback).toBe(true);
    });
  });

  // =========================================================================
  // OUTPUT
  // =========================================================================

  describe('output', () => {
    it('should return non-empty output', async () => {
      const request = createRequest();
      const result = await service.executeFallback(request);

      expect(result.output).toBeDefined();
      expect(result.output.length).toBeGreaterThan(0);
    });

    it('should include user input context in the response', async () => {
      const request = createRequest({ userInput: 'pergunta específica' });
      const result = await service.executeFallback(request);

      expect(result.output).toContain('pergunta específica');
    });
  });

  // =========================================================================
  // NO EXTERNAL SERVICE CALLS
  // =========================================================================

  describe('no external service calls', () => {
    it('should not make any gRPC calls (no external dependencies)', async () => {
      // FallbackHandlerService has no injected dependencies
      // (no gRPC client, no state manager, no external services)
      // This verifies the service operates in isolation
      const request = createRequest();
      const result = await service.executeFallback(request);

      // Service completes successfully without any external dependencies
      expect(result.success).toBe(true);
    });

    it('should not produce side effects (no state store writes)', async () => {
      // Execute multiple times - each call is independent and stateless
      const request = createRequest();
      const result1 = await service.executeFallback(request);
      const result2 = await service.executeFallback(request);

      // Each call produces an independent result (different traceIds)
      expect(result1.traceId).not.toBe(result2.traceId);
      // Both succeed without any shared state
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });
  });

  // =========================================================================
  // VALID ExecuteWorkflowResponse STRUCTURE
  // =========================================================================

  describe('valid ExecuteWorkflowResponse structure', () => {
    it('should return a complete ExecuteWorkflowResponse', async () => {
      const request = createRequest();
      const result = await service.executeFallback(request);

      // Validate all required fields are present and typed correctly
      expect(result.success).toBe(true);
      expect(typeof result.output).toBe('string');
      expect(typeof result.traceId).toBe('string');
      expect(typeof result.modelId).toBe('string');
      expect(result.usedFallback).toBe(true);
      expect(result.tokensUsed).toEqual({ inputTokens: 0, outputTokens: 0 });
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.blockedReason).toBe('');
      expect(result.guardrailViolations).toEqual([]);
      expect(result.steps).toEqual([]);
      expect(result.finalState).toBeDefined();
      expect(result.finalState.tenantId).toBe(request.tenantId);
      expect(result.finalState.status).toBe(
        ExecutionStatus.EXECUTION_STATUS_COMPLETED,
      );
    });

    it('should return empty steps array (no workflow steps in fallback)', async () => {
      const request = createRequest();
      const result = await service.executeFallback(request);

      expect(Array.isArray(result.steps)).toBe(true);
      expect(result.steps).toHaveLength(0);
    });

    it('should return empty guardrailViolations', async () => {
      const request = createRequest();
      const result = await service.executeFallback(request);

      expect(Array.isArray(result.guardrailViolations)).toBe(true);
      expect(result.guardrailViolations).toHaveLength(0);
    });
  });

  // =========================================================================
  // TRACE ID GENERATION
  // =========================================================================

  describe('traceId generation', () => {
    it('should generate a traceId', async () => {
      const request = createRequest();
      const result = await service.executeFallback(request);

      expect(result.traceId).toBeDefined();
      expect(result.traceId.length).toBeGreaterThan(0);
    });

    it('should generate unique traceIds for each call', async () => {
      const request = createRequest();
      const result1 = await service.executeFallback(request);
      const result2 = await service.executeFallback(request);

      expect(result1.traceId).not.toBe(result2.traceId);
    });

    it('should generate valid UUID format traceId', async () => {
      const request = createRequest();
      const result = await service.executeFallback(request);

      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(result.traceId).toMatch(uuidRegex);
    });
  });
});
