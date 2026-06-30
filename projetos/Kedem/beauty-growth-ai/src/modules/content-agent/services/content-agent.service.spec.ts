import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { ContentAgentService } from './content-agent.service';
import { LangGraphClientService } from '../../agent-execution/services/langgraph-client.service';
import { CircuitBreakerService } from '../../agent-execution/services/circuit-breaker.service';
import { AgentMemoryService } from '../../agent-memory/services/agent-memory.service';
import { ObservabilityService } from '../../observability/services/observability.service';
import { GrpcClientError } from '../../agent-execution/services/grpc-error-handler';
import {
  ExecuteWorkflowResponse,
  ExecutionStatus,
} from '../../agent-execution/interfaces/grpc-types';
import { GenerateBriefingDto, RefineBriefingDto } from '../dto';

describe('ContentAgentService', () => {
  let service: ContentAgentService;
  let langGraphClient: jest.Mocked<LangGraphClientService>;
  let circuitBreaker: jest.Mocked<CircuitBreakerService>;
  let agentMemoryService: jest.Mocked<AgentMemoryService>;
  let observabilityService: jest.Mocked<ObservabilityService>;

  const mockTenantId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '22222222-2222-2222-2222-222222222222';

  const validBriefingDto: GenerateBriefingDto = {
    tema: 'Promoção de verão para tratamento facial',
    redesSociais: ['instagram', 'facebook'],
    idioma: 'pt-BR',
  };

  const mockSuccessfulGrpcResponse: ExecuteWorkflowResponse = {
    success: true,
    output: JSON.stringify({
      legendas: {
        instagram: 'Legenda para Instagram sobre tratamento facial',
        facebook: 'Legenda para Facebook sobre tratamento facial',
      },
      hashtags: ['#beleza', '#tratamento', '#facial', '#verao', '#clinica'],
      sugestoes_visuais: {
        instagram: { formato: '1:1', descricao: 'Imagem antes e depois' },
        facebook: { formato: '1.91:1', descricao: 'Banner promocional' },
      },
      model_id: 'gpt-4o',
    }),
    traceId: 'trace-mock',
    modelId: 'gpt-4o',
    usedFallback: false,
    tokensUsed: { inputTokens: 500, outputTokens: 300 },
    durationMs: 2500,
    blockedReason: '',
    guardrailViolations: [],
    finalState: {
      executionId: 'mock-exec-id',
      workflowId: 'content_agent_workflow',
      tenantId: mockTenantId,
      status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
      stateData: {},
      currentNode: '',
      completedNodes: ['load_context', 'resolve_prompt', 'generate_content', 'validate_guardrails', 'persist_and_output'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    steps: [],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContentAgentService,
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
          },
        },
        {
          provide: AgentMemoryService,
          useValue: {
            getShortTermMemory: jest.fn(),
          },
        },
        {
          provide: ObservabilityService,
          useValue: {
            generateTraceId: jest.fn().mockReturnValue('trace-test-123'),
          },
        },
      ],
    }).compile();

    service = module.get<ContentAgentService>(ContentAgentService);
    langGraphClient = module.get(LangGraphClientService);
    circuitBreaker = module.get(CircuitBreakerService);
    agentMemoryService = module.get(AgentMemoryService);
    observabilityService = module.get(ObservabilityService);
  });

  describe('generate', () => {
    it('should generate content successfully and return ContentAgentResponse', async () => {
      circuitBreaker.execute.mockImplementation(async (fn) => fn());
      langGraphClient.executeWorkflow.mockResolvedValue(mockSuccessfulGrpcResponse);

      const result = await service.generate(validBriefingDto, mockTenantId, mockUserId);

      expect(result.status).toBe('draft');
      expect(result.executionId).toBeDefined();
      expect(result.version).toBe(1);
      expect(result.legendas.instagram).toBe('Legenda para Instagram sobre tratamento facial');
      expect(result.legendas.facebook).toBe('Legenda para Facebook sobre tratamento facial');
      expect(result.hashtags).toHaveLength(5);
      expect(result.modeloUtilizado).toBe('gpt-4o');
      expect(result.usouFallback).toBe(false);
      expect(result.tokensConsumidos).toEqual({ input: 500, output: 300 });
    });

    it('should generate a UUID v4 execution_id', async () => {
      circuitBreaker.execute.mockImplementation(async (fn) => fn());
      langGraphClient.executeWorkflow.mockResolvedValue(mockSuccessfulGrpcResponse);

      const result = await service.generate(validBriefingDto, mockTenantId, mockUserId);

      // UUID v4 format
      const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(result.executionId).toMatch(uuidV4Regex);
    });

    it('should pass briefing data in gRPC request payload', async () => {
      circuitBreaker.execute.mockImplementation(async (fn) => fn());
      langGraphClient.executeWorkflow.mockResolvedValue(mockSuccessfulGrpcResponse);

      await service.generate(validBriefingDto, mockTenantId, mockUserId);

      expect(langGraphClient.executeWorkflow).toHaveBeenCalledTimes(1);
      const grpcRequest = langGraphClient.executeWorkflow.mock.calls[0][0];

      expect(grpcRequest.agentId).toBe('content');
      expect(grpcRequest.tenantId).toBe(mockTenantId);
      expect(grpcRequest.userId).toBe(mockUserId);
      expect(grpcRequest.workflowId).toBe('content_agent_workflow');

      const parsedInput = JSON.parse(grpcRequest.userInput);
      expect(parsedInput.tema).toBe(validBriefingDto.tema);
      expect(parsedInput.redes_sociais).toEqual(['instagram', 'facebook']);
      expect(parsedInput.is_refinement).toBe(false);
    });

    it('should throw 422 when guardrail_blocked response received', async () => {
      const blockedResponse: ExecuteWorkflowResponse = {
        ...mockSuccessfulGrpcResponse,
        success: false,
        blockedReason: 'Conteúdo viola política de promessas de resultado',
      };

      circuitBreaker.execute.mockImplementation(async (fn) => fn());
      langGraphClient.executeWorkflow.mockResolvedValue(blockedResponse);

      await expect(
        service.generate(validBriefingDto, mockTenantId, mockUserId),
      ).rejects.toThrow(HttpException);

      try {
        await service.generate(validBriefingDto, mockTenantId, mockUserId);
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      }
    });

    it('should throw 503 when circuit breaker is open (fallback triggered)', async () => {
      circuitBreaker.execute.mockImplementation(async (_fn, fallback) => fallback());

      await expect(
        service.generate(validBriefingDto, mockTenantId, mockUserId),
      ).rejects.toThrow(HttpException);

      try {
        await service.generate(validBriefingDto, mockTenantId, mockUserId);
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      }
    });

    it('should map gRPC DEADLINE_EXCEEDED to 504', async () => {
      const timeoutError = new GrpcClientError({
        code: 4,
        message: 'Deadline exceeded',
        traceId: 'trace-1',
        isRetryable: true,
      });

      circuitBreaker.execute.mockRejectedValue(timeoutError);

      await expect(
        service.generate(validBriefingDto, mockTenantId, mockUserId),
      ).rejects.toThrow(HttpException);

      try {
        await service.generate(validBriefingDto, mockTenantId, mockUserId);
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
      }
    });

    it('should map gRPC UNAVAILABLE to 503', async () => {
      const unavailableError = new GrpcClientError({
        code: 14,
        message: 'Service unavailable',
        traceId: 'trace-1',
        isRetryable: true,
      });

      circuitBreaker.execute.mockRejectedValue(unavailableError);

      await expect(
        service.generate(validBriefingDto, mockTenantId, mockUserId),
      ).rejects.toThrow(HttpException);

      try {
        await service.generate(validBriefingDto, mockTenantId, mockUserId);
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      }
    });

    it('should map gRPC FAILED_PRECONDITION to 412', async () => {
      const preconditionError = new GrpcClientError({
        code: 9,
        message: 'tom_de_voz não configurado',
        traceId: 'trace-1',
        isRetryable: false,
      });

      circuitBreaker.execute.mockRejectedValue(preconditionError);

      await expect(
        service.generate(validBriefingDto, mockTenantId, mockUserId),
      ).rejects.toThrow(HttpException);

      try {
        await service.generate(validBriefingDto, mockTenantId, mockUserId);
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.PRECONDITION_FAILED);
      }
    });
  });

  describe('refine', () => {
    const mockExecutionId = '33333333-3333-3333-3333-333333333333';

    const validRefineDto: RefineBriefingDto = {
      executionId: mockExecutionId,
      instrucoes: 'Tornar o tom mais informal e jovem',
    };

    beforeEach(() => {
      // Mock: execution exists with version 1
      agentMemoryService.getShortTermMemory.mockResolvedValue([
        {
          id: 'mem-1',
          agentId: 'content',
          tenantId: mockTenantId,
          role: 'assistant',
          content: 'Generated content',
          timestamp: new Date(),
          metadata: { execution_id: mockExecutionId, version: 1 },
        },
      ]);
    });

    it('should refine content and increment version', async () => {
      circuitBreaker.execute.mockImplementation(async (fn) => fn());
      langGraphClient.executeWorkflow.mockResolvedValue(mockSuccessfulGrpcResponse);

      const result = await service.refine(validRefineDto, mockTenantId, mockUserId);

      expect(result.executionId).toBe(mockExecutionId);
      expect(result.version).toBe(2);
      expect(result.status).toBe('draft');
    });

    it('should pass is_refinement=true in gRPC payload', async () => {
      circuitBreaker.execute.mockImplementation(async (fn) => fn());
      langGraphClient.executeWorkflow.mockResolvedValue(mockSuccessfulGrpcResponse);

      await service.refine(validRefineDto, mockTenantId, mockUserId);

      const grpcRequest = langGraphClient.executeWorkflow.mock.calls[0][0];
      const parsedInput = JSON.parse(grpcRequest.userInput);

      expect(parsedInput.is_refinement).toBe(true);
      expect(parsedInput.original_execution_id).toBe(mockExecutionId);
      expect(parsedInput.version).toBe(2);
      expect(parsedInput.instrucoes).toBe('Tornar o tom mais informal e jovem');
    });

    it('should throw 404 when execution not found for tenant', async () => {
      agentMemoryService.getShortTermMemory.mockResolvedValue([]);

      await expect(
        service.refine(validRefineDto, mockTenantId, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw 429 when refinement limit (5) exceeded', async () => {
      // Mock: execution at version 6 (5 refinements already done, original was 1)
      agentMemoryService.getShortTermMemory.mockResolvedValue([
        {
          id: 'mem-1',
          agentId: 'content',
          tenantId: mockTenantId,
          role: 'assistant',
          content: 'Generated content v6',
          timestamp: new Date(),
          metadata: { execution_id: mockExecutionId, version: 6 },
        },
      ]);

      await expect(
        service.refine(validRefineDto, mockTenantId, mockUserId),
      ).rejects.toThrow(HttpException);

      try {
        await service.refine(validRefineDto, mockTenantId, mockUserId);
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      }
    });

    it('should allow up to 5 refinements (version 6 = 5 refinements done)', async () => {
      // version 5 means 4 refinements done, one more is allowed
      agentMemoryService.getShortTermMemory.mockResolvedValue([
        {
          id: 'mem-1',
          agentId: 'content',
          tenantId: mockTenantId,
          role: 'assistant',
          content: 'Generated content v5',
          timestamp: new Date(),
          metadata: { execution_id: mockExecutionId, version: 5 },
        },
      ]);

      circuitBreaker.execute.mockImplementation(async (fn) => fn());
      langGraphClient.executeWorkflow.mockResolvedValue(mockSuccessfulGrpcResponse);

      const result = await service.refine(validRefineDto, mockTenantId, mockUserId);
      expect(result.version).toBe(6);
    });

    it('should not reveal execution_id existence for other tenants', async () => {
      // Execution exists but for a different tenant — getShortTermMemory filters by tenant
      agentMemoryService.getShortTermMemory.mockResolvedValue([]);

      await expect(
        service.refine(validRefineDto, mockTenantId, mockUserId),
      ).rejects.toThrow(NotFoundException);

      try {
        await service.refine(validRefineDto, mockTenantId, mockUserId);
      } catch (error) {
        expect((error as HttpException).getResponse()).toEqual(
          expect.objectContaining({
            message: expect.not.stringContaining('outro tenant'),
          }),
        );
      }
    });
  });
});
