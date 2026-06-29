import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { AgentExecutionService } from './agent-execution.service';
import { AgentConfigService } from '../../agent-config/services/agent-config.service';
import { PromptRegistryService } from '../../prompt-registry/services/prompt-registry.service';
import { GuardrailsService } from '../../guardrails/services/guardrails.service';
import { AgentMemoryService } from '../../agent-memory/services/agent-memory.service';
import { ObservabilityService } from '../../observability/services/observability.service';
import { ModelRegistryService } from '../../model-registry/services/model-registry.service';
import { AgentExecutionRequest } from '../interfaces/agent-execution.interface';

describe('AgentExecutionService', () => {
  let service: AgentExecutionService;
  let agentConfigService: jest.Mocked<AgentConfigService>;
  let promptRegistryService: jest.Mocked<PromptRegistryService>;
  let guardrailsService: jest.Mocked<GuardrailsService>;
  let agentMemoryService: jest.Mocked<AgentMemoryService>;
  let observabilityService: jest.Mocked<ObservabilityService>;
  let modelRegistryService: jest.Mocked<ModelRegistryService>;

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
      ],
    }).compile();

    service = module.get<AgentExecutionService>(AgentExecutionService);
    agentConfigService = module.get(AgentConfigService);
    promptRegistryService = module.get(PromptRegistryService);
    guardrailsService = module.get(GuardrailsService);
    agentMemoryService = module.get(AgentMemoryService);
    observabilityService = module.get(ObservabilityService);
    modelRegistryService = module.get(ModelRegistryService);
  });

  // =========================================================================
  // HAPPY PATH: Full pipeline execution
  // =========================================================================

  describe('execute - happy path', () => {
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
      modelRegistryService.checkAvailability.mockResolvedValue({
        modelId: 'model-1',
        isAvailable: true,
        lastCheckedAt: new Date(),
      });
      modelRegistryService.trackUsage.mockResolvedValue(undefined);
      agentMemoryService.persistInteraction.mockResolvedValue(undefined);
      observabilityService.logAgentAction.mockResolvedValue(undefined);
    });

    it('should execute the full pipeline in order and return success', async () => {
      const callOrder: string[] = [];

      agentConfigService.list.mockImplementation(async () => {
        callOrder.push('1-loadConfig');
        return [mockAgentConfig as any];
      });

      promptRegistryService.resolve.mockImplementation(async () => {
        callOrder.push('2-resolvePrompt');
        return mockResolvedPrompt;
      });

      guardrailsService.validateWithRegeneration.mockImplementation(
        async (_content, _tenantId, _agentId, _attempt) => {
          if (callOrder[callOrder.length - 1] === '2-resolvePrompt') {
            callOrder.push('3-preGuardrails');
          } else {
            callOrder.push('5-postGuardrails');
          }
          return {
            success: true,
            attempt: 1,
            maxRetries: 3,
            blocked: false,
            violations: [],
          };
        },
      );

      modelRegistryService.checkAvailability.mockImplementation(async () => {
        callOrder.push('4-selectModel');
        return { modelId: 'model-1', isAvailable: true, lastCheckedAt: new Date() };
      });

      agentMemoryService.persistInteraction.mockImplementation(async () => {
        callOrder.push('7-persistMemory');
      });

      observabilityService.logAgentAction.mockImplementation(async () => {
        callOrder.push('8-logObservability');
      });

      modelRegistryService.trackUsage.mockImplementation(async () => {
        callOrder.push('9-trackTokens');
      });

      const result = await service.execute(mockRequest);

      // Verify successful result
      expect(result.success).toBe(true);
      expect(result.traceId).toBe('trace-test-123');
      expect(result.modelId).toBe('model-1');
      expect(result.usedFallback).toBe(false);
      expect(result.output).toBeTruthy();
      expect(result.tokensUsed.inputTokens).toBeGreaterThan(0);
      expect(result.tokensUsed.outputTokens).toBeGreaterThan(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // Verify pipeline order
      expect(callOrder).toContain('1-loadConfig');
      expect(callOrder).toContain('2-resolvePrompt');
      expect(callOrder).toContain('3-preGuardrails');
      expect(callOrder).toContain('4-selectModel');
      expect(callOrder).toContain('5-postGuardrails');
      expect(callOrder).toContain('7-persistMemory');
      expect(callOrder).toContain('8-logObservability');
      expect(callOrder).toContain('9-trackTokens');

      // Verify order is correct
      const configIdx = callOrder.indexOf('1-loadConfig');
      const promptIdx = callOrder.indexOf('2-resolvePrompt');
      const preGuardrailIdx = callOrder.indexOf('3-preGuardrails');
      const modelIdx = callOrder.indexOf('4-selectModel');
      const postGuardrailIdx = callOrder.indexOf('5-postGuardrails');

      expect(configIdx).toBeLessThan(promptIdx);
      expect(promptIdx).toBeLessThan(preGuardrailIdx);
      expect(preGuardrailIdx).toBeLessThan(modelIdx);
      expect(modelIdx).toBeLessThan(postGuardrailIdx);
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
          content: expect.any(String),
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
            inputTokens: expect.any(Number),
            outputTokens: expect.any(Number),
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
          inputTokens: expect.any(Number),
          outputTokens: expect.any(Number),
          agentId: 'agent-1',
          timestamp: expect.any(Date),
        }),
      );
    });
  });

  // =========================================================================
  // MODEL FALLBACK
  // =========================================================================

  describe('execute - model fallback routing', () => {
    beforeEach(() => {
      observabilityService.generateTraceId.mockReturnValue('trace-test-fallback');
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

    it('should use fallback model when primary is unavailable', async () => {
      modelRegistryService.checkAvailability
        .mockResolvedValueOnce({
          modelId: 'model-1',
          isAvailable: false,
          lastCheckedAt: new Date(),
          errorMessage: 'Model unavailable',
        })
        .mockResolvedValueOnce({
          modelId: 'model-2',
          isAvailable: true,
          lastCheckedAt: new Date(),
        });

      const result = await service.execute(mockRequest);

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(result.modelId).toBe('model-2');
    });

    it('should use automatic fallback from ModelRegistry when both configured models are down', async () => {
      modelRegistryService.checkAvailability.mockResolvedValue({
        modelId: 'model-1',
        isAvailable: false,
        lastCheckedAt: new Date(),
        errorMessage: 'Unavailable',
      });

      modelRegistryService.getFallback.mockResolvedValue({
        id: 'model-auto-fallback',
        provider: 'anthropic',
        name: 'claude-3',
        version: '1.0',
        capabilities: ['text_generation'],
        costPerInputToken: 0.001,
        costPerOutputToken: 0.002,
        contextWindow: 100000,
        status: 'available',
        maxTemperature: 2.0,
        maxOutputTokens: 4096,
      } as any);

      const result = await service.execute(mockRequest);

      expect(result.success).toBe(true);
      expect(result.usedFallback).toBe(true);
      expect(result.modelId).toBe('model-auto-fallback');
    });

    it('should throw ServiceUnavailableException when no model is available', async () => {
      modelRegistryService.checkAvailability.mockResolvedValue({
        modelId: 'model-1',
        isAvailable: false,
        lastCheckedAt: new Date(),
        errorMessage: 'Unavailable',
      });

      modelRegistryService.getFallback.mockResolvedValue(null);

      await expect(service.execute(mockRequest)).rejects.toThrow(
        ServiceUnavailableException,
      );
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
      // Should NOT call model or persist memory for blocked input
      expect(modelRegistryService.checkAvailability).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // GUARDRAILS - POST-GENERATION WITH REGENERATION
  // =========================================================================

  describe('execute - post-generation guardrails with regeneration', () => {
    beforeEach(() => {
      observabilityService.generateTraceId.mockReturnValue('trace-post-guard');
      agentConfigService.list.mockResolvedValue([mockAgentConfig as any]);
      promptRegistryService.resolve.mockResolvedValue(mockResolvedPrompt);
      modelRegistryService.checkAvailability.mockResolvedValue({
        modelId: 'model-1',
        isAvailable: true,
        lastCheckedAt: new Date(),
      });
      agentMemoryService.persistInteraction.mockResolvedValue(undefined);
      observabilityService.logAgentAction.mockResolvedValue(undefined);
      modelRegistryService.trackUsage.mockResolvedValue(undefined);
    });

    it('should regenerate when output violates guardrails then succeeds', async () => {
      // Pre-generation passes
      guardrailsService.validateWithRegeneration
        .mockResolvedValueOnce({
          success: true,
          attempt: 1,
          maxRetries: 3,
          blocked: false,
          violations: [],
        })
        // Post-generation attempt 1: fails
        .mockResolvedValueOnce({
          success: false,
          attempt: 1,
          maxRetries: 3,
          blocked: false,
          violations: [
            {
              guardrailId: 'g-1',
              guardrailName: 'no_health_promises',
              severity: 'high',
              description: 'Promises health results',
              matchedContent: 'guaranteed results',
            },
          ],
        })
        // Post-generation attempt 2: passes
        .mockResolvedValueOnce({
          success: true,
          attempt: 2,
          maxRetries: 3,
          blocked: false,
          violations: [],
        });

      const result = await service.execute(mockRequest);

      expect(result.success).toBe(true);
      expect(result.guardrailViolations).toContain('no_health_promises');
      // Tokens should accumulate from both attempts
      expect(result.tokensUsed.inputTokens).toBe(300); // 150 * 2
      expect(result.tokensUsed.outputTokens).toBe(200); // 100 * 2
    });

    it('should block after max regeneration attempts', async () => {
      // Pre-generation passes
      guardrailsService.validateWithRegeneration
        .mockResolvedValueOnce({
          success: true,
          attempt: 1,
          maxRetries: 3,
          blocked: false,
          violations: [],
        })
        // Post-gen attempt 1: fails
        .mockResolvedValueOnce({
          success: false,
          attempt: 1,
          maxRetries: 3,
          blocked: false,
          violations: [
            {
              guardrailId: 'g-1',
              guardrailName: 'no_health_promises',
              severity: 'critical',
              description: 'test',
              matchedContent: 'test',
            },
          ],
        })
        // Post-gen attempt 2: fails
        .mockResolvedValueOnce({
          success: false,
          attempt: 2,
          maxRetries: 3,
          blocked: false,
          violations: [
            {
              guardrailId: 'g-1',
              guardrailName: 'no_health_promises',
              severity: 'critical',
              description: 'test',
              matchedContent: 'test',
            },
          ],
        })
        // Post-gen attempt 3: blocked
        .mockResolvedValueOnce({
          success: false,
          attempt: 3,
          maxRetries: 3,
          blocked: true,
          violations: [
            {
              guardrailId: 'g-1',
              guardrailName: 'no_health_promises',
              severity: 'critical',
              description: 'test',
              matchedContent: 'test',
            },
          ],
        });

      const result = await service.execute(mockRequest);

      expect(result.success).toBe(false);
      expect(result.blockedReason).toContain('maximum regeneration attempts');
      expect(result.output).toBe('');
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
      modelRegistryService.checkAvailability.mockResolvedValue({
        modelId: 'model-1',
        isAvailable: true,
        lastCheckedAt: new Date(),
      });
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
  });
});
