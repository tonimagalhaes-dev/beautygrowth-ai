import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';

import { ContentAgentController } from '../content-agent.controller';
import { ContentAgentService } from '../services/content-agent.service';
import { LangGraphClientService } from '../../agent-execution/services/langgraph-client.service';
import { CircuitBreakerService } from '../../agent-execution/services/circuit-breaker.service';
import { AgentMemoryService } from '../../agent-memory/services/agent-memory.service';
import { ObservabilityService } from '../../observability/services/observability.service';
import { TenantGuard } from '@shared/guards/tenant.guard';
import { ExecuteWorkflowResponse, ExecutionStatus } from '../../agent-execution/interfaces/grpc-types';

/**
 * End-to-end integration tests for the Content Agent MVP.
 *
 * Tests the full pipeline from HTTP request → Controller → Service → (mocked) gRPC → Response.
 * The LLM/gRPC layer is mocked, but everything else (validation, guards, error mapping)
 * runs as close to production as possible.
 *
 * Validates: Requirements 1.1–1.4, 3.7, 4.3, 5.1, 5.4, 5.5, 6.3
 */
describe('ContentAgent E2E Integration', () => {
  let app: INestApplication;
  let langGraphClient: jest.Mocked<LangGraphClientService>;
  let circuitBreaker: jest.Mocked<CircuitBreakerService>;
  let agentMemoryService: jest.Mocked<AgentMemoryService>;
  let observabilityService: jest.Mocked<ObservabilityService>;

  // =========================================================================
  // FIXTURES
  // =========================================================================

  const TENANT_ID = 'tenant-e2e-001';
  const USER_ID = 'user-e2e-001';
  const TRACE_ID = 'trace-deterministic-e2e-001';

  const validBriefing = {
    tema: 'Benefícios do preenchimento labial para realçar a beleza natural',
    procedimento: '550e8400-e29b-41d4-a716-446655440000',
    publicoAlvoOverride: 'Mulheres 25-45 anos, classe A/B',
    redesSociais: ['instagram', 'facebook'],
    idioma: 'pt-BR',
  };

  const mockSuccessfulGrpcResponse: ExecuteWorkflowResponse = {
    success: true,
    output: JSON.stringify({
      legendas: {
        instagram: '✨ Descubra os benefícios do preenchimento labial! Realce a beleza natural dos seus lábios com segurança e naturalidade. Agende sua avaliação.',
        facebook: 'Preenchimento labial: realce a beleza natural dos seus lábios com segurança e tecnologia de ponta. Conheça nossos tratamentos personalizados para cada perfil.',
      },
      hashtags: [
        '#preenchimento',
        '#estetica',
        '#beleza',
        '#labios',
        '#harmonizacao',
        '#clinica',
        '#tratamento',
      ],
      sugestoes_visuais: {
        instagram: {
          formato: '4:5',
          descricao: 'Close-up lábios com iluminação suave',
        },
        facebook: {
          formato: '1.91:1',
          descricao: 'Banner clínica moderna com paciente sorrindo',
        },
      },
    }),
    traceId: TRACE_ID,
    modelId: 'gpt-4o',
    usedFallback: false,
    tokensUsed: { inputTokens: 850, outputTokens: 420 },
    durationMs: 3200,
    blockedReason: '',
    guardrailViolations: [],
    finalState: {
      executionId: 'exec-e2e-001',
      workflowId: 'content_agent_workflow',
      tenantId: TENANT_ID,
      status: ExecutionStatus.EXECUTION_STATUS_COMPLETED,
      stateData: {},
      currentNode: '',
      completedNodes: ['load_context', 'resolve_prompt', 'generate_content', 'validate_guardrails', 'persist_and_output'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    steps: [],
  };

  // =========================================================================
  // TEST MODULE SETUP
  // =========================================================================

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ContentAgentController],
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
            getState: jest.fn().mockReturnValue('CLOSED'),
            reset: jest.fn(),
          },
        },
        {
          provide: AgentMemoryService,
          useValue: {
            getShortTermMemory: jest.fn(),
            persistInteraction: jest.fn(),
          },
        },
        {
          provide: ObservabilityService,
          useValue: {
            generateTraceId: jest.fn().mockReturnValue(TRACE_ID),
            logAgentAction: jest.fn(),
          },
        },
      ],
    })
      // Override the TenantGuard to inject a deterministic tenant context
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate: (context: any) => {
          const req = context.switchToHttp().getRequest();
          req.tenantContext = {
            tenantId: TENANT_ID,
            userId: USER_ID,
            role: 'admin',
          };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: false,
      }),
    );
    app.setGlobalPrefix('api');
    await app.init();

    langGraphClient = moduleRef.get(LangGraphClientService);
    circuitBreaker = moduleRef.get(CircuitBreakerService);
    agentMemoryService = moduleRef.get(AgentMemoryService);
    observabilityService = moduleRef.get(ObservabilityService);
  });

  afterEach(async () => {
    await app.close();
  });

  // =========================================================================
  // HELPER: Configure happy-path mocks
  // =========================================================================

  function setupHappyPath() {
    circuitBreaker.execute.mockImplementation(async (fn) => fn());
    langGraphClient.executeWorkflow.mockResolvedValue(mockSuccessfulGrpcResponse);
  }

  // =========================================================================
  // TEST 1: Happy path — Generate content
  // Validates: Requirements 1.4, 3.7
  // =========================================================================

  describe('POST /api/content-agent/generate — Happy path', () => {
    beforeEach(() => setupHappyPath());

    it('should return 200 with a complete ContentAgentResponse', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/content-agent/generate')
        .send(validBriefing)
        .expect(200);

      const body = res.body;

      // Verify top-level response structure
      expect(body.executionId).toBeDefined();
      expect(body.status).toBe('draft');
      expect(body.version).toBe(1);

      // Verify legendas per network
      expect(body.legendas).toBeDefined();
      expect(body.legendas.instagram).toContain('preenchimento labial');
      expect(body.legendas.facebook).toContain('Preenchimento labial');

      // Verify hashtags
      expect(body.hashtags).toBeInstanceOf(Array);
      expect(body.hashtags.length).toBeGreaterThanOrEqual(5);
      expect(body.hashtags.length).toBeLessThanOrEqual(15);
      expect(body.hashtags).toContain('#preenchimento');

      // Verify sugestões visuais
      expect(body.sugestoesVisuais).toBeDefined();
      expect(body.sugestoesVisuais.instagram.formato).toBe('4:5');
      expect(body.sugestoesVisuais.facebook.formato).toBe('1.91:1');

      // Verify metadata
      expect(body.modeloUtilizado).toBe('gpt-4o');
      expect(body.usouFallback).toBe(false);
      expect(body.tokensConsumidos).toEqual({ input: 850, output: 420 });
      expect(body.duracaoMs).toBeGreaterThanOrEqual(0);
    });

    it('should invoke LangGraphClientService.executeWorkflow via circuit breaker', async () => {
      await request(app.getHttpServer())
        .post('/api/content-agent/generate')
        .send(validBriefing)
        .expect(200);

      expect(circuitBreaker.execute).toHaveBeenCalledTimes(1);
      expect(langGraphClient.executeWorkflow).toHaveBeenCalledTimes(1);

      const grpcRequest = langGraphClient.executeWorkflow.mock.calls[0][0];
      expect(grpcRequest.agentId).toBe('content');
      expect(grpcRequest.tenantId).toBe(TENANT_ID);
      expect(grpcRequest.userId).toBe(USER_ID);
      expect(grpcRequest.workflowId).toBe('content_agent_workflow');

      const parsedInput = JSON.parse(grpcRequest.userInput);
      expect(parsedInput.tema).toBe(validBriefing.tema);
      expect(parsedInput.redes_sociais).toEqual(validBriefing.redesSociais);
      expect(parsedInput.is_refinement).toBe(false);
    });
  });

  // =========================================================================
  // TEST 2: Validation error — Invalid briefing (empty tema)
  // Validates: Requirements 1.2
  // =========================================================================

  describe('POST /api/content-agent/generate — Validation: empty tema', () => {
    it('should return 400 with field-level error messages when tema is empty', async () => {
      const invalidBriefing = {
        ...validBriefing,
        tema: '',
      };

      const res = await request(app.getHttpServer())
        .post('/api/content-agent/generate')
        .send(invalidBriefing)
        .expect(400);

      expect(res.body.message).toBeInstanceOf(Array);
      const messages: string[] = res.body.message;
      expect(messages.some((m) => m.includes('tema'))).toBe(true);

      // Ensure no workflow was triggered
      expect(circuitBreaker.execute).not.toHaveBeenCalled();
      expect(langGraphClient.executeWorkflow).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // TEST 3: Validation error — Empty redesSociais
  // Validates: Requirements 1.2
  // =========================================================================

  describe('POST /api/content-agent/generate — Validation: empty redesSociais', () => {
    it('should return 400 when redesSociais is an empty array', async () => {
      const invalidBriefing = {
        ...validBriefing,
        redesSociais: [],
      };

      const res = await request(app.getHttpServer())
        .post('/api/content-agent/generate')
        .send(invalidBriefing)
        .expect(400);

      expect(res.body.message).toBeInstanceOf(Array);
      const messages: string[] = res.body.message;
      expect(messages.some((m) => m.toLowerCase().includes('rede social') || m.includes('redesSociais'))).toBe(true);

      // Ensure no workflow was triggered
      expect(circuitBreaker.execute).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // TEST 4: Guardrail blocked — LLM returns content violating guardrails 3 times
  // Validates: Requirements 4.3
  // =========================================================================

  describe('POST /api/content-agent/generate — Guardrail blocked', () => {
    it('should return 422 when gRPC response indicates guardrail violation after 3 attempts', async () => {
      const blockedGrpcResponse: ExecuteWorkflowResponse = {
        ...mockSuccessfulGrpcResponse,
        success: false,
        output: '',
        blockedReason: 'O conteúdo solicitado não pode ser gerado em conformidade com as políticas vigentes',
        guardrailViolations: ['no_health_promises', 'no_diagnosis', 'no_prescriptions'],
      };

      circuitBreaker.execute.mockImplementation(async (fn) => fn());
      langGraphClient.executeWorkflow.mockResolvedValue(blockedGrpcResponse);

      const res = await request(app.getHttpServer())
        .post('/api/content-agent/generate')
        .send(validBriefing)
        .expect(422);

      expect(res.body.statusCode).toBe(422);
      expect(res.body.message).toContain('conformidade');
    });
  });

  // =========================================================================
  // TEST 5: Refinement — Success
  // Validates: Requirements 5.1, 5.4
  // =========================================================================

  describe('POST /api/content-agent/refine — Success', () => {
    it('should return 200 with incremented version when refining existing execution', async () => {
      const executionId = '550e8400-e29b-41d4-a716-446655440001';

      // Mock: previous execution found in short-term memory with version=1
      agentMemoryService.getShortTermMemory.mockResolvedValue([
        {
          id: 'mem-1',
          agentId: 'content',
          tenantId: TENANT_ID,
          role: 'assistant',
          content: 'previous content',
          timestamp: new Date(),
          metadata: { execution_id: executionId, version: 1 },
        },
      ]);

      // Mock: gRPC returns successful refinement
      const refinedGrpcResponse: ExecuteWorkflowResponse = {
        ...mockSuccessfulGrpcResponse,
        output: JSON.stringify({
          legendas: {
            instagram: '✨ Versão refinada do conteúdo sobre preenchimento labial!',
            facebook: 'Preenchimento labial refinado: nova abordagem com foco em naturalidade.',
          },
          hashtags: ['#preenchimento', '#estetica', '#beleza', '#labios', '#harmonizacao', '#natural', '#clinica'],
          sugestoes_visuais: {
            instagram: { formato: '4:5', descricao: 'Close-up natural com iluminação quente' },
            facebook: { formato: '1.91:1', descricao: 'Banner com paciente sorrindo naturalmente' },
          },
        }),
      };

      circuitBreaker.execute.mockImplementation(async (fn) => fn());
      langGraphClient.executeWorkflow.mockResolvedValue(refinedGrpcResponse);

      const res = await request(app.getHttpServer())
        .post('/api/content-agent/refine')
        .send({
          executionId,
          instrucoes: 'Tornar o tom mais natural e descontraído',
        })
        .expect(200);

      const body = res.body;

      expect(body.executionId).toBe(executionId);
      expect(body.version).toBe(2);
      expect(body.status).toBe('draft');
      expect(body.legendas.instagram).toContain('refinada');
    });
  });

  // =========================================================================
  // TEST 6: Refinement — Not found (execution_id does not exist)
  // Validates: Requirements 5.5
  // =========================================================================

  describe('POST /api/content-agent/refine — Not found', () => {
    it('should return 404 when executionId does not exist for the tenant', async () => {
      const nonExistentId = '550e8400-e29b-41d4-a716-446655440099';

      // Mock: no interactions found for this execution_id
      agentMemoryService.getShortTermMemory.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .post('/api/content-agent/refine')
        .send({
          executionId: nonExistentId,
          instrucoes: 'Ajustar o tom de voz para mais formal',
        })
        .expect(404);

      expect(res.body.statusCode).toBe(404);
      expect(res.body.message).toContain('não encontrada');

      // Ensure no gRPC call was made
      expect(circuitBreaker.execute).not.toHaveBeenCalled();
      expect(langGraphClient.executeWorkflow).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // TEST 7: Service unavailable — Circuit breaker open (503)
  // Validates: Requirements 6.3
  // =========================================================================

  describe('POST /api/content-agent/generate — Service unavailable (circuit breaker)', () => {
    it('should return 503 when circuit breaker triggers fallback (LangGraph down)', async () => {
      // Circuit breaker calls fallback (which throws 503 for content agent)
      circuitBreaker.execute.mockImplementation(async (_fn, fallback) => fallback());

      const res = await request(app.getHttpServer())
        .post('/api/content-agent/generate')
        .send(validBriefing)
        .expect(503);

      expect(res.body.statusCode).toBe(503);
      expect(res.body.message).toContain('temporariamente indisponível');

      // LangGraph should NOT have been called directly
      expect(langGraphClient.executeWorkflow).not.toHaveBeenCalled();
    });
  });
});
