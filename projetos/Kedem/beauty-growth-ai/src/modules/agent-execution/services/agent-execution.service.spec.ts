import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { AgentExecutionService } from './agent-execution.service';
import { LangGraphClientService } from './langgraph-client.service';
import { CircuitBreakerService } from './circuit-breaker.service';
import { FallbackHandlerService } from './fallback-handler.service';
import { AgentConfigService } from '../../agent-config/services/agent-config.service';
import { PromptRegistryService } from '../../prompt-registry/services/prompt-registry.service';
import { GuardrailsService } from '../../guardrails/services/guardrails.service';
import { AgentMemoryService } from '../../agent-memory/services/agent-memory.service';
import { ObservabilityService } from '../../observability/services/observability.service';
import { ModelRegistryService } from '../../model-registry/services/model-registry.service';
import { AgentExecutionRequest } from '../interfaces/agent-execution.interface';
import { ExecuteWorkflowResponse, ExecutionStatus } from '../interfaces/grpc-types';

describe('AgentExecutionService', () => {
  let service: AgentExecutionService;
  let agentConfigService: jest.Mocked<AgentConfigService>;
  let promptRegistryService: jest.Mocked<PromptRegistryService>;
  let guardrailsService: jest.Mocked<GuardrailsService>;
  let agentMemoryService: jest.Mocked<AgentMemoryService>;
  let observabilityService: jest.Mocked<ObservabilityService>;
  let modelRegistryService: jest.Mocked<ModelRegistryService>;
  let langGraphClient: jest.Mocked<LangGraphClientService>;
  let circuitBreaker: jest.Mocked<CircuitBreakerService>;
  let fallbackHandler: jest.Mocked<FallbackHandlerService>;

  const mockAgentConfig = {
    id: 'agent-1',
    tenantId: 'tenant-1',
    agentType: 'content' as const,
    status: 'active' as const,
    modelId: 'model-1',
    temperature: 0.7,
    maxTokens: 2048,
    systemPromptId: 'prompt-1',
    knowledgeCategories: [],
    fallbackModelId: 'model-2',
    lastExecutedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockResolvedPrompt = {
    content: 'You are a helpful assistant for {{nome_clinica}}',
    version: '1.0.0',
    resolvedVariables: { nome_clinica: 'Test Clinic' },
    unresolvedVariables: [],
  };

  const mockRequest: AgentExecutionRequest = {
    agentId: 'agent-1',
    tenantId: 'tenant-1',
    userInput: 'Create a social media post about skincare',
    userId: 'user-1',
    tenantContext: { nome_clinica: 'Test Clinic' },
  };

  const mockGrpcResponse: ExecuteWorkflowResponse = {
    success: true,
    output: 'Generated content from LangGraph',
    traceId: 'grpc-trace-123',
    modelId: 'model-1',
    usedFallback: false,
    tokensUsed: { inputTokens: 150, outputTokens: 100 },
    durationMs: 500,
    blockedReason: '',
    guardrailViolations: [],
    finalState: {
      executionId: 'exec-1',
      workflowId: 'wf-1',
      tenantId: 'tenant-1',
      status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
      stateData: {},
      currentNode: '',
      completedNodes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    steps: [],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentExecutionService,
        {
          provide: AgentConfigService,
          useValue: {
            list: jest.fn(),
          },
        },
        {
          provide: PromptRegistryService,
          useValue: {
            resolve: jest.fn(),
          },
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
          useValue: {
            persistInteraction: jest.fn(),
          },
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

    service = module.get<AgentExecutionService>(AgentExecutionService);
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

  // =========================================================================
  // HAPPY PATH: Full pipeline execution via LangGraph gRPC
  // =========================================================================

  describe('execute - happy path (LangGraph delegation)', () => {
    beforeEach(() => {
      observabilityService.generateTraceId.mockReturnValue('trace-test-123');
      agentConfigService.list.mockResolvedValue([mockAgentConfig as any]);
      promptRegistryService.resolve.mockResolvedValue(mockResolvedPrompt);
      guardrailsService.validateWithRegeneration.mockResolvedValue({
        success: true,
        attempt: 1,
        maxRetries: 3,
        blocked: false,
        violations: [],
      });
      // Circuit breaker delegates to the primary fn (LangGraph client)
      circuitBreaker.execute.mockImplementation(async (fn) => fn());
      langGraphClient.executeWorkflow.mockResolvedValue(mockGrpcResponse);
      modelRegistryService.trackUsage.mockResolvedValue(undefined);
      agentMemoryService.persistInteraction.mockResolvedValue(undefined);
      observabilityService.logAgentAction.mockResolvedValue(undefined);
    });

    it('should execute via LangGraph gRPC and return success', async () => {
      const result = await service.execute(mockRequest);

      expect(result.success).toBe(true);
      expect(result.traceId).toBe('trace-test-123');
      expect(result.modelId).toBe('model-1');
      expect(result.usedFallback).toBe(false);
      expect(result.output).toBe('Generated content from LangGraph');
      expect(result.tokensUsed.inputTokens).toBe(150);
      expect(result.tokensUsed.outputTokens).toBe(100);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should call circuit breaker with LangGraph client as primary function', async () => {
      await service.execute(mockRequest);

      expect(circuitBreaker.execute).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Function),
      );
    });

    it('should pass correct gRPC request to LangGraph client', async () => {
      await service.execute(mockRequest);

      expect(langGraphClient.executeWorkflow).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          tenantId: 'tenant-1',
          userInput: 'Create a social media post about skincare',
          userId: 'user-1',
        }),
      );
    });

    it('should generate a trace_id for end-to-end correlation', async () => {
      const result = await service.execute(mockRequest);

      expect(observabilityService.generateTraceId).toHaveBeenCalled();
      expect(result.traceId).toBe('trace-test-123');
    });

    it('should resolve prompt with tenant context variables', async () => {
      await service.execute(mockRequest);

      expect(promptRegistryService.resolve).toHaveBeenCalledWith(
        'prompt-1',
        { nome_clinica: 'Test Clinic' },
      );
    });

    it('should persist both user and assistant interactions to memory', async () => {
      await service.execute(mockRequest);

      expect(agentMemoryService.persistInteraction).toHaveBeenCalledTimes(2);

      // User input
      expect(agentMemoryService.persistInteraction).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          tenantId: 'tenant-1',
          role: 'user',
          content: 'Create a social media post about skincare',
        }),
      );

      // Assistant output
      expect(agentMemoryService.persistInteraction).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          tenantId: 'tenant-1',
          role: 'assistant',
          content: 'Generated content from LangGraph',
        }),
      );
    });

    it('should log execution to observability with correct fields', async () => {
      await service.execute(mockRequest);

      expect(observabilityService.logAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'trace-test-123',
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          actionType: 'agent_execution',
          input: 'Create a social media post about skincare',
          status: 'success',
          durationMs: expect.any(Number),
          tokensUsed: expect.objectContaining({
            inputTokens: 150,
            outputTokens: 100,
          }),
        }),
      );
    });

    it('should track token usage via ModelRegistry', async () => {
      await service.execute(mockRequest);

      expect(modelRegistryService.trackUsage).toHaveBeenCalledWith(
        'tenant-1',
        'model-1',
        expect.objectContaining({
          inputTokens: 150,
          outputTokens: 100,
          agentId: 'agent-1',
          timestamp: expect.any(Date),
        }),
      );
    });
  });

  // =========================================================================
  // CIRCUIT BREAKER FALLBACK
  // =========================================================================

  describe('execute - circuit breaker fallback', () => {
    const mockFallbackResponse: ExecuteWorkflowResponse = {
      success: true,
      output: '[Fallback Mode] Response',
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
        tenantId: 'tenant-1',
        status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
        stateData: {},
        currentNode: '',
        completedNodes: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      steps: [],
    };

    beforeEach(() => {
      observabilityService.generateTraceId.mockReturnValue('trace-fallback');
      agentConfigService.list.mockResolvedValue([mockAgentConfig as any]);
      promptRegistryService.resolve.mockResolvedValue(mockResolvedPrompt);
      guardrailsService.validateWithRegeneration.mockResolvedValue({
        success: true,
        attempt: 1,
        maxRetries: 3,
        blocked: false,
        violations: [],
      });
      agentMemoryService.persistInteraction.mockResolvedValue(undefined);
      observabilityService.logAgentAction.mockResolvedValue(undefined);
      modelRegistryService.trackUsage.mockResolvedValue(undefined);
    });

    it('should use fallback when circuit breaker is OPEN', async () => {
      // Circuit breaker calls the fallback function
      circuitBreaker.execute.mockImplementation(async (_fn, fallback) => fallback());
      fallbackHandler.executeFallback.mockResolvedValue(mockFallbackResponse);

      const result = await service.execute(mockRequest);

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(result.output).toBe('[Fallback Mode] Response');
      expect(result.modelId).toBe('fallback-direct');
    });

    it('should use fallback when LangGraph client fails and circuit opens', async () => {
      // Circuit breaker tries fn, fails, then calls fallback
      circuitBreaker.execute.mockImplementation(async (fn, fallback) => {
        try {
          return await fn();
        } catch {
          return fallback();
        }
      });
      langGraphClient.executeWorkflow.mockRejectedValue(new Error('UNAVAILABLE'));
      fallbackHandler.executeFallback.mockResolvedValue(mockFallbackResponse);

      const result = await service.execute(mockRequest);

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
    });
  });

  // =========================================================================
  // GUARDRAILS - PRE-GENERATION
  // =========================================================================

  describe('execute - pre-generation guardrails', () => {
    beforeEach(() => {
      observabilityService.generateTraceId.mockReturnValue('trace-pre-guard');
      agentConfigService.list.mockResolvedValue([mockAgentConfig as any]);
      promptRegistryService.resolve.mockResolvedValue(mockResolvedPrompt);
      observabilityService.logAgentAction.mockResolvedValue(undefined);
      modelRegistryService.trackUsage.mockResolvedValue(undefined);
    });

    it('should block execution when input violates guardrails', async () => {
      guardrailsService.validateWithRegeneration.mockResolvedValueOnce({
        success: false,
        attempt: 1,
        maxRetries: 3,
        blocked: true,
        violations: [
          {
            guardrailId: 'g-1',
            guardrailName: 'no_medical_diagnosis',
            severity: 'critical',
            description: 'Content contains medical diagnosis',
            matchedContent: 'diagnose this condition',
          },
        ],
      });

      const result = await service.execute(mockRequest);

      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe('Input content blocked by guardrails');
      expect(result.guardrailViolations).toContain('no_medical_diagnosis');
      // Should NOT call LangGraph or circuit breaker for blocked input
      expect(circuitBreaker.execute).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GRPC RESPONSE WITH GUARDRAIL VIOLATIONS
  // =========================================================================

  describe('execute - gRPC response with guardrail violations', () => {
    beforeEach(() => {
      observabilityService.generateTraceId.mockReturnValue('trace-grpc-guard');
      agentConfigService.list.mockResolvedValue([mockAgentConfig as any]);
      promptRegistryService.resolve.mockResolvedValue(mockResolvedPrompt);
      guardrailsService.validateWithRegeneration.mockResolvedValue({
        success: true,
        attempt: 1,
        maxRetries: 3,
        blocked: false,
        violations: [],
      });
      agentMemoryService.persistInteraction.mockResolvedValue(undefined);
      observabilityService.logAgentAction.mockResolvedValue(undefined);
      modelRegistryService.trackUsage.mockResolvedValue(undefined);
    });

    it('should propagate guardrail violations from gRPC response', async () => {
      const responseWithViolations: ExecuteWorkflowResponse = {
        ...mockGrpcResponse,
        success: false,
        output: '',
        blockedReason: 'Guardrail violation in workflow',
        guardrailViolations: ['no_health_promises', 'no_medical_diagnosis'],
      };

      circuitBreaker.execute.mockImplementation(async (fn) => fn());
      langGraphClient.executeWorkflow.mockResolvedValue(responseWithViolations);

      const result = await service.execute(mockRequest);

      expect(result.success).toBe(false);
      expect(result.blockedReason).toBe('Guardrail violation in workflow');
      expect(result.guardrailViolations).toContain('no_health_promises');
      expect(result.guardrailViolations).toContain('no_medical_diagnosis');
    });
  });

  // =========================================================================
  // EDGE CASES
  // =========================================================================

  describe('execute - edge cases', () => {
    beforeEach(() => {
      observabilityService.generateTraceId.mockReturnValue('trace-edge');
      observabilityService.logAgentAction.mockResolvedValue(undefined);
    });

    it('should throw NotFoundException when agent does not exist', async () => {
      agentConfigService.list.mockResolvedValue([]);

      await expect(service.execute(mockRequest)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ServiceUnavailableException when agent is inactive', async () => {
      agentConfigService.list.mockResolvedValue([
        { ...mockAgentConfig, status: 'inactive' } as any,
      ]);

      await expect(service.execute(mockRequest)).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it('should handle execution without a system prompt configured', async () => {
      const agentNoPrompt = { ...mockAgentConfig, systemPromptId: null };
      agentConfigService.list.mockResolvedValue([agentNoPrompt as any]);
      guardrailsService.validateWithRegeneration.mockResolvedValue({
        success: true,
        attempt: 1,
        maxRetries: 3,
        blocked: false,
        violations: [],
      });
      circuitBreaker.execute.mockImplementation(async (fn) => fn());
      langGraphClient.executeWorkflow.mockResolvedValue(mockGrpcResponse);
      agentMemoryService.persistInteraction.mockResolvedValue(undefined);
      modelRegistryService.trackUsage.mockResolvedValue(undefined);

      const result = await service.execute(mockRequest);

      expect(result.success).toBe(true);
      // Should NOT call promptRegistryService.resolve
      expect(promptRegistryService.resolve).not.toHaveBeenCalled();
    });

    it('should log error to observability when execution throws', async () => {
      agentConfigService.list.mockRejectedValue(new Error('DB connection failed'));

      await expect(service.execute(mockRequest)).rejects.toThrow('DB connection failed');

      expect(observabilityService.logAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'trace-edge',
          status: 'error',
          tenantId: 'tenant-1',
          agentId: 'agent-1',
        }),
      );
    });

    it('should propagate error when circuit breaker throws', async () => {
      agentConfigService.list.mockResolvedValue([mockAgentConfig as any]);
      promptRegistryService.resolve.mockResolvedValue(mockResolvedPrompt);
      guardrailsService.validateWithRegeneration.mockResolvedValue({
        success: true,
        attempt: 1,
        maxRetries: 3,
        blocked: false,
        violations: [],
      });
      circuitBreaker.execute.mockRejectedValue(new Error('gRPC call timed out'));

      await expect(service.execute(mockRequest)).rejects.toThrow('gRPC call timed out');
    });
  });
});
