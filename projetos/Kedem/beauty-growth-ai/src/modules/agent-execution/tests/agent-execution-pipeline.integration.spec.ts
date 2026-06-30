import { Test, TestingModule } from '@nestjs/testing';

import { AgentExecutionService } from '../services/agent-execution.service';
import { LangGraphClientService } from '../services/langgraph-client.service';
import { CircuitBreakerService } from '../services/circuit-breaker.service';
import { FallbackHandlerService } from '../services/fallback-handler.service';
import { AgentConfigService } from '../../agent-config/services/agent-config.service';
import { PromptRegistryService } from '../../prompt-registry/services/prompt-registry.service';
import { GuardrailsService } from '../../guardrails/services/guardrails.service';
import { AgentMemoryService } from '../../agent-memory/services/agent-memory.service';
import { ObservabilityService } from '../../observability/services/observability.service';
import { ModelRegistryService } from '../../model-registry/services/model-registry.service';
import { AgentExecutionRequest } from '../interfaces/agent-execution.interface';
import { ExecuteWorkflowResponse, ExecutionStatus } from '../interfaces/grpc-types';

/**
 * Integration tests for the full Agent Execution Pipeline.
 *
 * These tests verify the wiring and interaction patterns between all services
 * in the execution pipeline using NestJS TestingModule with mocked dependencies.
 *
 * The pipeline now delegates to LangGraph via gRPC with circuit breaker protection:
 * config → prompt → guardrails → circuit breaker → LangGraph gRPC / fallback → memory → observability
 *
 * Validates: Requirements 1.1, 2.2, 5.4, 10.6, 13.1
 */
describe('AgentExecutionPipeline Integration', () => {
  let module: TestingModule;
  let executionService: AgentExecutionService;
  let agentConfigService: jest.Mocked<AgentConfigService>;
  let promptRegistryService: jest.Mocked<PromptRegistryService>;
  let guardrailsService: jest.Mocked<GuardrailsService>;
  let agentMemoryService: jest.Mocked<AgentMemoryService>;
  let observabilityService: jest.Mocked<ObservabilityService>;
  let modelRegistryService: jest.Mocked<ModelRegistryService>;
  let langGraphClient: jest.Mocked<LangGraphClientService>;
  let circuitBreaker: jest.Mocked<CircuitBreakerService>;
  let fallbackHandler: jest.Mocked<FallbackHandlerService>;

  // =========================================================================
  // FIXTURES
  // =========================================================================

  const TENANT_ID = 'tenant-integration-1';
  const AGENT_ID = 'agent-content-1';
  const USER_ID = 'user-integration-1';
  const PRIMARY_MODEL = 'gpt-4o';
  const TRACE_ID = 'trace-integration-abc123';

  const mockActiveAgent = {
    id: AGENT_ID,
    tenantId: TENANT_ID,
    agentType: 'content' as const,
    status: 'active' as const,
    modelId: PRIMARY_MODEL,
    temperature: 0.7,
    maxTokens: 2048,
    systemPromptId: 'prompt-system-1',
    knowledgeCategories: ['skincare', 'marketing'],
    fallbackModelId: 'claude-3-sonnet',
    lastExecutedAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  const mockResolvedPrompt = {
    content: 'Você é um assistente de marketing para {{nome_clinica}}. Tom: profissional e acolhedor.',
    version: '2.1.0',
    resolvedVariables: { nome_clinica: 'Clínica Kedem' },
    unresolvedVariables: [],
  };

  const baseRequest: AgentExecutionRequest = {
    agentId: AGENT_ID,
    tenantId: TENANT_ID,
    userInput: 'Crie um post sobre cuidados com a pele no inverno',
    userId: USER_ID,
    tenantContext: { nome_clinica: 'Clínica Kedem' },
  };

  const mockGrpcResponse: ExecuteWorkflowResponse = {
    success: true,
    output: 'Conteúdo gerado pelo LangGraph sobre cuidados com a pele no inverno.',
    traceId: 'grpc-trace-xyz',
    modelId: PRIMARY_MODEL,
    usedFallback: false,
    tokensUsed: { inputTokens: 250, outputTokens: 180 },
    durationMs: 800,
    blockedReason: '',
    guardrailViolations: [],
    finalState: {
      executionId: 'exec-integration-1',
      workflowId: 'wf-content-1',
      tenantId: TENANT_ID,
      status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
      stateData: {},
      currentNode: '',
      completedNodes: ['plan', 'generate', 'review'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    steps: [],
  };

  const mockFallbackResponse: ExecuteWorkflowResponse = {
    success: true,
    output: '[Fallback Mode] Resposta direta para cuidados com a pele.',
    traceId: 'fallback-trace',
    modelId: 'fallback-direct',
    usedFallback: true,
    tokensUsed: { inputTokens: 0, outputTokens: 0 },
    durationMs: 50,
    blockedReason: '',
    guardrailViolations: [],
    finalState: {
      executionId: 'fb-1',
      workflowId: '',
      tenantId: TENANT_ID,
      status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
      stateData: {},
      currentNode: '',
      completedNodes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    steps: [],
  };

  // =========================================================================
  // MODULE SETUP
  // =========================================================================

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        AgentExecutionService,
        {
          provide: AgentConfigService,
          useValue: { list: jest.fn() },
        },
        {
          provide: PromptRegistryService,
          useValue: { resolve: jest.fn() },
        },
        {
          provide: GuardrailsService,
          useValue: {
            validate: jest.fn(),
            validateWithRegeneration: jest.fn(),
          },
        },
        {
          provide: AgentMemoryService,
          useValue: { persistInteraction: jest.fn() },
        },
        {
          provide: ObservabilityService,
          useValue: {
            generateTraceId: jest.fn(),
            logAgentAction: jest.fn(),
          },
        },
        {
          provide: ModelRegistryService,
          useValue: {
            checkAvailability: jest.fn(),
            getFallback: jest.fn(),
            trackUsage: jest.fn(),
          },
        },
        {
          provide: LangGraphClientService,
          useValue: {
            executeWorkflow: jest.fn(),
          },
        },
        {
          provide: CircuitBreakerService,
          useValue: {
            execute: jest.fn(),
            getState: jest.fn(),
            reset: jest.fn(),
          },
        },
        {
          provide: FallbackHandlerService,
          useValue: {
            executeFallback: jest.fn(),
          },
        },
      ],
    }).compile();

    executionService = module.get(AgentExecutionService);
    agentConfigService = module.get(AgentConfigService);
    promptRegistryService = module.get(PromptRegistryService);
    guardrailsService = module.get(GuardrailsService);
    agentMemoryService = module.get(AgentMemoryService);
    observabilityService = module.get(ObservabilityService);
    modelRegistryService = module.get(ModelRegistryService);
    langGraphClient = module.get(LangGraphClientService);
    circuitBreaker = module.get(CircuitBreakerService);
    fallbackHandler = module.get(FallbackHandlerService);
  });

  afterEach(async () => {
    await module.close();
  });

  // =========================================================================
  // HELPER: Set up the default happy-path mocks
  // =========================================================================

  function setupHappyPathMocks() {
    observabilityService.generateTraceId.mockReturnValue(TRACE_ID);
    agentConfigService.list.mockResolvedValue([mockActiveAgent as any]);
    promptRegistryService.resolve.mockResolvedValue(mockResolvedPrompt);
    guardrailsService.validateWithRegeneration.mockResolvedValue({
      success: true,
      attempt: 1,
      maxRetries: 3,
      blocked: false,
      violations: [],
    });
    // Circuit breaker delegates to the primary fn (LangGraph)
    circuitBreaker.execute.mockImplementation(async (fn) => fn());
    langGraphClient.executeWorkflow.mockResolvedValue(mockGrpcResponse);
    modelRegistryService.trackUsage.mockResolvedValue(undefined);
    agentMemoryService.persistInteraction.mockResolvedValue(undefined);
    observabilityService.logAgentAction.mockResolvedValue(undefined);
  }

  // =========================================================================
  // TEST 1: Full pipeline happy path (via LangGraph gRPC)
  // Validates: Requirements 1.1, 5.4, 10.6, 13.1
  // =========================================================================

  describe('Full pipeline happy path (LangGraph delegation)', () => {
    beforeEach(() => setupHappyPathMocks());

    it('should execute all pipeline steps in sequence and return successful result', async () => {
      const stepLog: string[] = [];

      agentConfigService.list.mockImplementation(async () => {
        stepLog.push('config');
        return [mockActiveAgent as any];
      });
      promptRegistryService.resolve.mockImplementation(async () => {
        stepLog.push('prompt');
        return mockResolvedPrompt;
      });
      guardrailsService.validateWithRegeneration.mockImplementation(async () => {
        stepLog.push('guardrails');
        return { success: true, attempt: 1, maxRetries: 3, blocked: false, violations: [] };
      });
      circuitBreaker.execute.mockImplementation(async (fn) => {
        stepLog.push('circuit-breaker');
        return fn();
      });
      langGraphClient.executeWorkflow.mockImplementation(async () => {
        stepLog.push('langgraph-grpc');
        return mockGrpcResponse;
      });
      agentMemoryService.persistInteraction.mockImplementation(async () => {
        stepLog.push('memory-persist');
      });
      observabilityService.logAgentAction.mockImplementation(async () => {
        stepLog.push('observability-log');
      });
      modelRegistryService.trackUsage.mockImplementation(async () => {
        stepLog.push('token-track');
      });

      const result = await executionService.execute(baseRequest);

      // Verify successful result structure
      expect(result.success).toBe(true);
      expect(result.traceId).toBe(TRACE_ID);
      expect(result.modelId).toBe(PRIMARY_MODEL);
      expect(result.usedFallback).toBe(false);
      expect(result.output).toBe('Conteúdo gerado pelo LangGraph sobre cuidados com a pele no inverno.');
      expect(result.tokensUsed.inputTokens).toBe(250);
      expect(result.tokensUsed.outputTokens).toBe(180);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.blockedReason).toBeUndefined();

      // Verify all pipeline steps were called
      expect(stepLog).toContain('config');
      expect(stepLog).toContain('prompt');
      expect(stepLog).toContain('guardrails');
      expect(stepLog).toContain('circuit-breaker');
      expect(stepLog).toContain('langgraph-grpc');
      expect(stepLog).toContain('memory-persist');
      expect(stepLog).toContain('observability-log');
      expect(stepLog).toContain('token-track');

      // Verify correct ordering
      const configIdx = stepLog.indexOf('config');
      const promptIdx = stepLog.indexOf('prompt');
      const guardrailIdx = stepLog.indexOf('guardrails');
      const cbIdx = stepLog.indexOf('circuit-breaker');
      const grpcIdx = stepLog.indexOf('langgraph-grpc');

      expect(configIdx).toBeLessThan(promptIdx);
      expect(promptIdx).toBeLessThan(guardrailIdx);
      expect(guardrailIdx).toBeLessThan(cbIdx);
      expect(cbIdx).toBeLessThan(grpcIdx);
    });

    it('should resolve prompt template with tenant context variables', async () => {
      const result = await executionService.execute(baseRequest);

      expect(result.success).toBe(true);
      expect(promptRegistryService.resolve).toHaveBeenCalledWith(
        'prompt-system-1',
        { nome_clinica: 'Clínica Kedem' },
      );
    });

    it('should persist both user and assistant interactions to memory', async () => {
      await executionService.execute(baseRequest);

      expect(agentMemoryService.persistInteraction).toHaveBeenCalledTimes(2);

      // Verify user message persisted
      expect(agentMemoryService.persistInteraction).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          tenantId: TENANT_ID,
          role: 'user',
          content: baseRequest.userInput,
        }),
      );

      // Verify assistant response persisted
      expect(agentMemoryService.persistInteraction).toHaveBeenCalledWith(
        AGENT_ID,
        expect.objectContaining({
          tenantId: TENANT_ID,
          role: 'assistant',
          content: 'Conteúdo gerado pelo LangGraph sobre cuidados com a pele no inverno.',
        }),
      );
    });

    it('should log execution to observability with all required fields', async () => {
      await executionService.execute(baseRequest);

      expect(observabilityService.logAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: TRACE_ID,
          tenantId: TENANT_ID,
          agentId: AGENT_ID,
          actionType: 'agent_execution',
          input: baseRequest.userInput,
          status: 'success',
          durationMs: expect.any(Number),
          tokensUsed: expect.objectContaining({
            inputTokens: 250,
            outputTokens: 180,
          }),
        }),
      );
    });

    it('should track token usage via model registry after successful execution', async () => {
      await executionService.execute(baseRequest);

      expect(modelRegistryService.trackUsage).toHaveBeenCalledWith(
        TENANT_ID,
        PRIMARY_MODEL,
        expect.objectContaining({
          inputTokens: 250,
          outputTokens: 180,
          agentId: AGENT_ID,
          timestamp: expect.any(Date),
        }),
      );
    });
  });

  // =========================================================================
  // TEST 2: Fallback routing when LangGraph is unavailable (circuit breaker)
  // Validates: Requirements 2.2
  // =========================================================================

  describe('Fallback routing (circuit breaker)', () => {
    beforeEach(() => setupHappyPathMocks());

    it('should use fallback when circuit breaker routes to it (LangGraph unavailable)', async () => {
      // Circuit breaker directly calls fallback (OPEN state)
      circuitBreaker.execute.mockImplementation(async (_fn, fallback) => fallback());
      fallbackHandler.executeFallback.mockResolvedValue(mockFallbackResponse);

      const result = await executionService.execute(baseRequest);

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(result.output).toBe('[Fallback Mode] Resposta direta para cuidados com a pele.');
      expect(result.modelId).toBe('fallback-direct');
    });

    it('should propagate error when both primary and fallback fail via circuit breaker', async () => {
      circuitBreaker.execute.mockRejectedValue(
        new Error('LangGraph service is not reachable: Connection refused'),
      );

      await expect(executionService.execute(baseRequest)).rejects.toThrow(
        'LangGraph service is not reachable',
      );

      // Verify error was logged to observability
      expect(observabilityService.logAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: TRACE_ID,
          status: 'error',
          tenantId: TENANT_ID,
          agentId: AGENT_ID,
        }),
      );
    });
  });

  // =========================================================================
  // TEST 3: Input blocked by pre-generation guardrails
  // Validates: Requirements 11.3, 11.4
  // =========================================================================

  describe('Input blocked by pre-generation guardrails', () => {
    beforeEach(() => setupHappyPathMocks());

    it('should stop execution before calling LangGraph when input violates guardrails', async () => {
      // Pre-generation guardrails block the input
      guardrailsService.validateWithRegeneration.mockResolvedValueOnce({
        success: false,
        attempt: 1,
        maxRetries: 3,
        blocked: true,
        violations: [{
          guardrailId: 'sys-no-prescriptions',
          guardrailName: 'no_prescriptions',
          severity: 'critical' as const,
          description: 'User input requests medical prescription',
          matchedContent: 'me receite um medicamento para acne',
        }],
      });

      const result = await executionService.execute(baseRequest);

      // Execution blocked
      expect(result.success).toBe(false);
      expect(result.output).toBe('');
      expect(result.blockedReason).toBe('Input content blocked by guardrails');
      expect(result.guardrailViolations).toContain('no_prescriptions');

      // Circuit breaker / LangGraph should NOT be called
      expect(circuitBreaker.execute).not.toHaveBeenCalled();
      expect(langGraphClient.executeWorkflow).not.toHaveBeenCalled();

      // Tokens should be zero since LangGraph was never called
      expect(result.tokensUsed.inputTokens).toBe(0);
      expect(result.tokensUsed.outputTokens).toBe(0);

      // Observability should still log the blocked attempt
      expect(observabilityService.logAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: TRACE_ID,
          tenantId: TENANT_ID,
          agentId: AGENT_ID,
          status: 'error',
        }),
      );
    });
  });

  // =========================================================================
  // TEST 4: gRPC response with guardrail violations from LangGraph
  // Validates: Requirements 1.1
  // =========================================================================

  describe('gRPC response with guardrail violations from LangGraph', () => {
    beforeEach(() => setupHappyPathMocks());

    it('should propagate guardrail violations returned by LangGraph via gRPC', async () => {
      const grpcResponseWithViolations: ExecuteWorkflowResponse = {
        ...mockGrpcResponse,
        success: false,
        output: '',
        blockedReason: 'Guardrail violation in LangGraph workflow',
        guardrailViolations: ['no_health_promises', 'no_diagnosis'],
      };

      langGraphClient.executeWorkflow.mockResolvedValue(grpcResponseWithViolations);

      const result = await executionService.execute(baseRequest);

      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe('Guardrail violation in LangGraph workflow');
      expect(result.guardrailViolations).toContain('no_health_promises');
      expect(result.guardrailViolations).toContain('no_diagnosis');
    });
  });

  // =========================================================================
  // TEST 5: Trace correlation across pipeline
  // Validates: Requirements 13.1
  // =========================================================================

  describe('Trace correlation', () => {
    beforeEach(() => setupHappyPathMocks());

    it('should use the same trace_id throughout the entire pipeline and in observability log', async () => {
      const capturedTraceIds: string[] = [];

      observabilityService.logAgentAction.mockImplementation(async (entry: any) => {
        capturedTraceIds.push(entry.traceId);
      });

      const result = await executionService.execute(baseRequest);

      // The result trace_id should match what was generated
      expect(result.traceId).toBe(TRACE_ID);

      // All observability log entries should use the same trace_id
      expect(capturedTraceIds.length).toBeGreaterThan(0);
      capturedTraceIds.forEach((id) => {
        expect(id).toBe(TRACE_ID);
      });

      // generateTraceId should be called exactly once per execution
      expect(observabilityService.generateTraceId).toHaveBeenCalledTimes(1);
    });

    it('should propagate the same trace_id even when execution fails with error', async () => {
      const capturedTraceIds: string[] = [];

      observabilityService.logAgentAction.mockImplementation(async (entry: any) => {
        capturedTraceIds.push(entry.traceId);
      });

      // Force an error mid-execution
      circuitBreaker.execute.mockRejectedValue(new Error('Connection refused'));

      await expect(executionService.execute(baseRequest)).rejects.toThrow();

      // Error log should still contain the same trace_id
      expect(capturedTraceIds.length).toBeGreaterThan(0);
      capturedTraceIds.forEach((id) => {
        expect(id).toBe(TRACE_ID);
      });
    });

    it('should propagate trace_id to observability for blocked executions', async () => {
      guardrailsService.validateWithRegeneration.mockResolvedValueOnce({
        success: false,
        attempt: 1,
        maxRetries: 3,
        blocked: true,
        violations: [{
          guardrailId: 'g-1',
          guardrailName: 'blocked_rule',
          severity: 'critical' as const,
          description: 'test',
          matchedContent: 'test',
        }],
      });

      const result = await executionService.execute(baseRequest);

      expect(result.traceId).toBe(TRACE_ID);
      expect(observabilityService.logAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({ traceId: TRACE_ID }),
      );
    });
  });
});
