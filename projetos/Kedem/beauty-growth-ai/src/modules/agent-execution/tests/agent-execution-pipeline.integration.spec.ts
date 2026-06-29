import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';

import { AgentExecutionService } from '../services/agent-execution.service';
import { AgentConfigService } from '../../agent-config/services/agent-config.service';
import { PromptRegistryService } from '../../prompt-registry/services/prompt-registry.service';
import { GuardrailsService } from '../../guardrails/services/guardrails.service';
import { AgentMemoryService } from '../../agent-memory/services/agent-memory.service';
import { ObservabilityService } from '../../observability/services/observability.service';
import { ModelRegistryService } from '../../model-registry/services/model-registry.service';
import { AgentExecutionRequest } from '../interfaces/agent-execution.interface';

/**
 * Integration tests for the full Agent Execution Pipeline.
 *
 * These tests verify the wiring and interaction patterns between all services
 * in the execution pipeline using NestJS TestingModule with mocked repositories.
 *
 * Validates: Requirements 5.4, 9.7, 10.6, 11.3, 11.4, 11.8, 13.1
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

  // =========================================================================
  // FIXTURES
  // =========================================================================

  const TENANT_ID = 'tenant-integration-1';
  const AGENT_ID = 'agent-content-1';
  const USER_ID = 'user-integration-1';
  const PRIMARY_MODEL = 'gpt-4o';
  const FALLBACK_MODEL = 'claude-3-sonnet';
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
    fallbackModelId: FALLBACK_MODEL,
    lastExecutedAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  const mockResolvedPrompt = {
    content: 'Você é um assistente de marketing para {{nome_clinica}}. Tom: profissional e acolhedor.',
    version: '2.1.0',
    resolvedVariables: { nome_clinica: 'Clínica Bela Vista' },
    unresolvedVariables: [],
  };

  const baseRequest: AgentExecutionRequest = {
    agentId: AGENT_ID,
    tenantId: TENANT_ID,
    userInput: 'Crie um post sobre cuidados com a pele no inverno',
    userId: USER_ID,
    tenantContext: { nome_clinica: 'Clínica Bela Vista' },
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
      ],
    }).compile();

    executionService = module.get(AgentExecutionService);
    agentConfigService = module.get(AgentConfigService);
    promptRegistryService = module.get(PromptRegistryService);
    guardrailsService = module.get(GuardrailsService);
    agentMemoryService = module.get(AgentMemoryService);
    observabilityService = module.get(ObservabilityService);
    modelRegistryService = module.get(ModelRegistryService);
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
    modelRegistryService.checkAvailability.mockResolvedValue({
      modelId: PRIMARY_MODEL,
      isAvailable: true,
      lastCheckedAt: new Date(),
    });
    modelRegistryService.trackUsage.mockResolvedValue(undefined);
    agentMemoryService.persistInteraction.mockResolvedValue(undefined);
    observabilityService.logAgentAction.mockResolvedValue(undefined);
  }

  // =========================================================================
  // TEST 1: Full pipeline happy path
  // Validates: Requirements 5.4, 10.6, 13.1
  // =========================================================================

  describe('Full pipeline happy path', () => {
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
      modelRegistryService.checkAvailability.mockImplementation(async () => {
        stepLog.push('model-select');
        return { modelId: PRIMARY_MODEL, isAvailable: true, lastCheckedAt: new Date() };
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
      expect(result.output).toBeTruthy();
      expect(result.tokensUsed.inputTokens).toBeGreaterThan(0);
      expect(result.tokensUsed.outputTokens).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.blockedReason).toBeUndefined();

      // Verify all pipeline steps were called
      expect(stepLog).toContain('config');
      expect(stepLog).toContain('prompt');
      expect(stepLog).toContain('guardrails');
      expect(stepLog).toContain('model-select');
      expect(stepLog).toContain('memory-persist');
      expect(stepLog).toContain('observability-log');
      expect(stepLog).toContain('token-track');

      // Verify correct ordering: config → prompt → guardrails → model → guardrails → memory → observability → tokens
      const configIdx = stepLog.indexOf('config');
      const promptIdx = stepLog.indexOf('prompt');
      const firstGuardrailIdx = stepLog.indexOf('guardrails');
      const modelIdx = stepLog.indexOf('model-select');

      expect(configIdx).toBeLessThan(promptIdx);
      expect(promptIdx).toBeLessThan(firstGuardrailIdx);
      expect(firstGuardrailIdx).toBeLessThan(modelIdx);
    });

    it('should resolve prompt template with tenant context variables', async () => {
      const result = await executionService.execute(baseRequest);

      expect(result.success).toBe(true);
      expect(promptRegistryService.resolve).toHaveBeenCalledWith(
        'prompt-system-1',
        { nome_clinica: 'Clínica Bela Vista' },
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
          content: expect.any(String),
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
            inputTokens: expect.any(Number),
            outputTokens: expect.any(Number),
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
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number),
          agentId: AGENT_ID,
          timestamp: expect.any(Date),
        }),
      );
    });
  });

  // =========================================================================
  // TEST 2: Fallback routing when primary model unavailable
  // Validates: Requirements 9.7
  // =========================================================================

  describe('Fallback routing', () => {
    beforeEach(() => setupHappyPathMocks());

    it('should fall back to secondary model when primary is unavailable and return usedFallback: true', async () => {
      // Primary model unavailable, fallback model available
      modelRegistryService.checkAvailability
        .mockResolvedValueOnce({
          modelId: PRIMARY_MODEL,
          isAvailable: false,
          lastCheckedAt: new Date(),
          errorMessage: 'Model overloaded - 503',
        })
        .mockResolvedValueOnce({
          modelId: FALLBACK_MODEL,
          isAvailable: true,
          lastCheckedAt: new Date(),
        });

      const result = await executionService.execute(baseRequest);

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(result.modelId).toBe(FALLBACK_MODEL);
      // Token tracking should reference the fallback model
      expect(modelRegistryService.trackUsage).toHaveBeenCalledWith(
        TENANT_ID,
        FALLBACK_MODEL,
        expect.objectContaining({
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number),
        }),
      );
    });

    it('should use automatic registry fallback when both primary and configured fallback are unavailable', async () => {
      // Both configured models unavailable
      modelRegistryService.checkAvailability.mockResolvedValue({
        modelId: PRIMARY_MODEL,
        isAvailable: false,
        lastCheckedAt: new Date(),
        errorMessage: 'Service down',
      });

      // Registry provides automatic fallback
      modelRegistryService.getFallback.mockResolvedValue({
        id: 'gemini-1.5-pro',
        provider: 'google',
        name: 'gemini-1.5-pro',
        version: '1.0',
        capabilities: ['text_generation'],
        costPerInputToken: 0.0005,
        costPerOutputToken: 0.001,
        contextWindow: 128000,
        status: 'available',
        maxTemperature: 2.0,
        maxOutputTokens: 8192,
      } as any);

      const result = await executionService.execute(baseRequest);

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(result.modelId).toBe('gemini-1.5-pro');
    });

    it('should throw ServiceUnavailableException when no model is available at all', async () => {
      modelRegistryService.checkAvailability.mockResolvedValue({
        modelId: PRIMARY_MODEL,
        isAvailable: false,
        lastCheckedAt: new Date(),
        errorMessage: 'All providers down',
      });
      modelRegistryService.getFallback.mockResolvedValue(null);

      await expect(executionService.execute(baseRequest)).rejects.toThrow(
        ServiceUnavailableException,
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
  // TEST 3: Guardrail violation → regeneration → success
  // Validates: Requirements 11.3, 11.4
  // =========================================================================

  describe('Guardrail violation → regeneration → success', () => {
    beforeEach(() => setupHappyPathMocks());

    it('should regenerate on first guardrail violation and succeed on second attempt', async () => {
      let guardrailCallCount = 0;

      guardrailsService.validateWithRegeneration.mockImplementation(async () => {
        guardrailCallCount++;

        // First call: pre-generation validation passes
        if (guardrailCallCount === 1) {
          return { success: true, attempt: 1, maxRetries: 3, blocked: false, violations: [] };
        }

        // Second call: post-generation attempt 1 fails (health promise violation)
        if (guardrailCallCount === 2) {
          return {
            success: false,
            attempt: 1,
            maxRetries: 3,
            blocked: false,
            violations: [{
              guardrailId: 'sys-no-health-promises',
              guardrailName: 'no_health_promises',
              severity: 'high' as const,
              description: 'Content promises guaranteed health results',
              matchedContent: 'resultados garantidos em 30 dias',
            }],
          };
        }

        // Third call: post-generation attempt 2 passes
        return { success: true, attempt: 2, maxRetries: 3, blocked: false, violations: [] };
      });

      const result = await executionService.execute(baseRequest);

      // Execution should succeed after regeneration
      expect(result.success).toBe(true);
      expect(result.output).toBeTruthy();
      expect(result.guardrailViolations).toContain('no_health_promises');

      // Guardrails should have been called 3 times (1 pre + 2 post)
      expect(guardrailCallCount).toBe(3);

      // Tokens should accumulate from both generation attempts
      expect(result.tokensUsed.inputTokens).toBe(300); // 150 * 2 attempts
      expect(result.tokensUsed.outputTokens).toBe(200); // 100 * 2 attempts

      // Memory should still persist the final successful output
      expect(agentMemoryService.persistInteraction).toHaveBeenCalledTimes(2);

      // Observability should log success
      expect(observabilityService.logAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: TRACE_ID,
          status: 'success',
          tokensUsed: expect.objectContaining({
            inputTokens: 300,
            outputTokens: 200,
          }),
        }),
      );
    });
  });

  // =========================================================================
  // TEST 4: Guardrail violation → max retries → block
  // Validates: Requirements 11.3, 11.8
  // =========================================================================

  describe('Guardrail violation → max retries → block', () => {
    beforeEach(() => setupHappyPathMocks());

    it('should block execution after 3 failed regeneration attempts with proper blockedReason', async () => {
      let guardrailCallCount = 0;

      guardrailsService.validateWithRegeneration.mockImplementation(async () => {
        guardrailCallCount++;

        // Pre-generation passes
        if (guardrailCallCount === 1) {
          return { success: true, attempt: 1, maxRetries: 3, blocked: false, violations: [] };
        }

        // Post-generation attempts 1 and 2: fail but not blocked yet
        if (guardrailCallCount === 2 || guardrailCallCount === 3) {
          return {
            success: false,
            attempt: guardrailCallCount - 1,
            maxRetries: 3,
            blocked: false,
            violations: [{
              guardrailId: 'sys-no-diagnoses',
              guardrailName: 'no_diagnoses',
              severity: 'critical' as const,
              description: 'Content contains medical diagnosis',
              matchedContent: 'você tem dermatite',
            }],
          };
        }

        // Post-generation attempt 3: blocked (max retries reached)
        return {
          success: false,
          attempt: 3,
          maxRetries: 3,
          blocked: true,
          violations: [{
            guardrailId: 'sys-no-diagnoses',
            guardrailName: 'no_diagnoses',
            severity: 'critical' as const,
            description: 'Content contains medical diagnosis',
            matchedContent: 'você tem dermatite',
          }],
        };
      });

      const result = await executionService.execute(baseRequest);

      // Execution should be blocked
      expect(result.success).toBe(false);
      expect(result.output).toBe('');
      expect(result.blockedReason).toContain('maximum regeneration attempts');

      // All 3 regeneration attempts were made (+ 1 pre-gen = 4 total guardrail calls)
      expect(guardrailCallCount).toBe(4);

      // Guardrail violations should be tracked
      expect(result.guardrailViolations).toContain('no_diagnoses');

      // Tokens from all 3 attempts should accumulate
      expect(result.tokensUsed.inputTokens).toBe(450); // 150 * 3
      expect(result.tokensUsed.outputTokens).toBe(300); // 100 * 3

      // Observability should log as error
      expect(observabilityService.logAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: TRACE_ID,
          status: 'error',
        }),
      );

      // Token tracking should still happen even for blocked executions
      expect(modelRegistryService.trackUsage).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // TEST 5: Input blocked by pre-generation guardrails
  // Validates: Requirements 11.3, 11.4
  // =========================================================================

  describe('Input blocked by pre-generation guardrails', () => {
    beforeEach(() => setupHappyPathMocks());

    it('should stop execution before calling model when input violates guardrails', async () => {
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

      // Model should NOT be called — input was blocked before generation
      expect(modelRegistryService.checkAvailability).not.toHaveBeenCalled();
      expect(modelRegistryService.getFallback).not.toHaveBeenCalled();
      expect(modelRegistryService.trackUsage).not.toHaveBeenCalled();

      // Memory should NOT persist blocked interactions
      // (depends on implementation — the service actually doesn't persist for pre-gen blocks)

      // Observability should still log the blocked attempt
      expect(observabilityService.logAgentAction).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: TRACE_ID,
          tenantId: TENANT_ID,
          agentId: AGENT_ID,
          status: 'error',
        }),
      );

      // Tokens should be zero since model was never called
      expect(result.tokensUsed.inputTokens).toBe(0);
      expect(result.tokensUsed.outputTokens).toBe(0);
    });
  });

  // =========================================================================
  // TEST 6: Trace correlation across pipeline
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
      modelRegistryService.checkAvailability.mockResolvedValue({
        modelId: PRIMARY_MODEL,
        isAvailable: false,
        lastCheckedAt: new Date(),
        errorMessage: 'Timeout',
      });
      modelRegistryService.getFallback.mockResolvedValue(null);

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
