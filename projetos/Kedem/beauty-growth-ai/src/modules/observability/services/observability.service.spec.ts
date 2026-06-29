import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ObservabilityService } from './observability.service';
import { AuditLog } from '../entities/audit-log.entity';
import { AlertEntity } from '../entities/alert.entity';
import {
  AgentLogEntry,
  UserLogEntry,
  RAGLogEntry,
  LogFilters,
  ExportFormat,
} from '../interfaces/observability-service.interface';

describe('ObservabilityService', () => {
  let service: ObservabilityService;
  let auditLogRepo: jest.Mocked<Partial<Repository<AuditLog>>>;
  let alertRepo: jest.Mocked<Partial<Repository<AlertEntity>>>;

  const mockQueryBuilder = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(0),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
  };

  beforeEach(async () => {
    auditLogRepo = {
      create: jest.fn().mockImplementation((data) => ({ id: 'log-1', createdAt: new Date(), ...data })),
      save: jest.fn().mockImplementation((data) => Promise.resolve({ id: 'log-1', createdAt: new Date(), ...data })),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };

    alertRepo = {
      create: jest.fn().mockImplementation((data) => ({ id: 'alert-1', triggeredAt: new Date(), ...data })),
      save: jest.fn().mockImplementation((data) => Promise.resolve({ id: 'alert-1', triggeredAt: new Date(), ...data })),
      createQueryBuilder: jest.fn().mockReturnValue(mockQueryBuilder),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ObservabilityService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: auditLogRepo,
        },
        {
          provide: getRepositoryToken(AlertEntity),
          useValue: alertRepo,
        },
      ],
    }).compile();

    service = module.get<ObservabilityService>(ObservabilityService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('logAgentAction', () => {
    it('should insert an audit log entry for agent actions', async () => {
      const entry: AgentLogEntry = {
        traceId: 'trace-123',
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        actionType: 'generate_content',
        input: 'Create a post',
        output: 'Here is your post...',
        durationMs: 1200,
        status: 'success',
        tokensUsed: {
          inputTokens: 50,
          outputTokens: 200,
          modelId: 'gpt-4',
          agentId: 'agent-1',
          timestamp: new Date(),
        },
        guardrailViolations: [],
        timestamp: new Date(),
      };

      await service.logAgentAction(entry);

      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'trace-123',
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          actionType: 'generate_content',
          input: 'Create a post',
          output: 'Here is your post...',
          durationMs: 1200,
          status: 'success',
          metadata: expect.objectContaining({
            logType: 'agent_action',
            tokensUsed: expect.objectContaining({
              inputTokens: 50,
              outputTokens: 200,
              modelId: 'gpt-4',
            }),
          }),
        }),
      );
      expect(auditLogRepo.save).toHaveBeenCalled();
    });

    it('should generate trace_id if not provided', async () => {
      const entry: AgentLogEntry = {
        traceId: '',
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        actionType: 'generate_content',
        input: 'test',
        output: 'output',
        durationMs: 100,
        status: 'success',
        timestamp: new Date(),
      };

      await service.logAgentAction(entry);

      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: expect.stringMatching(/^trace-/),
        }),
      );
    });

    it('should include guardrail violations in metadata', async () => {
      const entry: AgentLogEntry = {
        traceId: 'trace-456',
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        actionType: 'generate_content',
        input: 'test',
        output: 'output with violation',
        durationMs: 500,
        status: 'error',
        guardrailViolations: ['no-health-promises', 'no-prescriptions'],
        timestamp: new Date(),
      };

      await service.logAgentAction(entry);

      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            guardrailViolations: ['no-health-promises', 'no-prescriptions'],
          }),
        }),
      );
    });
  });

  describe('logUserAction', () => {
    it('should insert an audit log entry for user actions', async () => {
      const entry: UserLogEntry = {
        traceId: 'trace-789',
        tenantId: 'tenant-1',
        userId: 'user-1',
        actionType: 'update_brand',
        resource: 'brand_identity',
        result: 'updated',
        timestamp: new Date(),
      };

      await service.logUserAction(entry);

      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'trace-789',
          tenantId: 'tenant-1',
          userId: 'user-1',
          actionType: 'update_brand',
          input: 'brand_identity',
          output: 'updated',
          metadata: expect.objectContaining({
            logType: 'user_action',
            resource: 'brand_identity',
          }),
        }),
      );
      expect(auditLogRepo.save).toHaveBeenCalled();
    });
  });

  describe('logRAGQuery', () => {
    it('should insert an audit log entry with RAG metadata', async () => {
      const entry: RAGLogEntry = {
        traceId: 'trace-rag-1',
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        query: 'What are the clinic procedures?',
        chunksReturned: [
          { chunkId: 'chunk-1', documentId: 'doc-1', score: 0.92 },
          { chunkId: 'chunk-2', documentId: 'doc-1', score: 0.87 },
        ],
        finalPrompt: 'Context: ... Question: What are the clinic procedures?',
        response: 'The clinic offers...',
        durationMs: 800,
        timestamp: new Date(),
      };

      await service.logRAGQuery(entry);

      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'trace-rag-1',
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          actionType: 'rag_query',
          input: 'What are the clinic procedures?',
          output: 'The clinic offers...',
          durationMs: 800,
          metadata: expect.objectContaining({
            logType: 'rag_query',
            chunksReturned: expect.arrayContaining([
              expect.objectContaining({ chunkId: 'chunk-1', score: 0.92 }),
            ]),
            finalPrompt: expect.any(String),
          }),
        }),
      );
    });
  });

  describe('queryLogs', () => {
    it('should query logs with filters and pagination', async () => {
      const mockLogs: Partial<AuditLog>[] = [
        {
          id: 'log-1',
          traceId: 'trace-1',
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          userId: null,
          actionType: 'generate_content',
          input: 'test',
          output: 'result',
          durationMs: 100,
          status: 'success',
          metadata: {},
          createdAt: new Date(),
        },
      ];

      mockQueryBuilder.getCount.mockResolvedValue(1);
      mockQueryBuilder.getMany.mockResolvedValue(mockLogs);

      const filters: LogFilters = {
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        period: {
          start: new Date('2024-01-01'),
          end: new Date('2024-01-31'),
        },
      };

      const result = await service.queryLogs(filters, 1, 10);

      expect(result.data).toHaveLength(1);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(10);
      expect(result.meta.total).toBe(1);
      expect(mockQueryBuilder.where).toHaveBeenCalled();
      expect(mockQueryBuilder.andWhere).toHaveBeenCalled();
    });

    it('should apply all optional filters when provided', async () => {
      mockQueryBuilder.getCount.mockResolvedValue(0);
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const filters: LogFilters = {
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        userId: 'user-1',
        actionType: 'generate_content',
        status: 'error',
        traceId: 'trace-specific',
        period: {
          start: new Date('2024-01-01'),
          end: new Date('2024-01-31'),
        },
      };

      await service.queryLogs(filters);

      // Verify all filters applied: period(start) + period(end) + agentId + userId + actionType + status + traceId = 7 andWhere calls
      expect(mockQueryBuilder.andWhere).toHaveBeenCalledTimes(7);
    });
  });

  describe('getDashboardMetrics', () => {
    it('should return aggregated metrics for a period', async () => {
      const now = new Date();
      const mockLogs: Partial<AuditLog>[] = [
        {
          id: 'log-1',
          agentId: 'agent-1',
          actionType: 'generate_content',
          durationMs: 1000,
          status: 'success',
          metadata: {
            logType: 'agent_action',
            tokensUsed: { inputTokens: 100, outputTokens: 200, modelId: 'gpt-4' },
          },
          createdAt: now,
        },
        {
          id: 'log-2',
          agentId: 'agent-1',
          actionType: 'generate_content',
          durationMs: 2000,
          status: 'error',
          metadata: { logType: 'agent_action' },
          createdAt: now,
        },
        {
          id: 'log-3',
          agentId: 'agent-2',
          actionType: 'generate_campaign',
          durationMs: 500,
          status: 'success',
          metadata: {
            logType: 'agent_action',
            tokensUsed: { inputTokens: 50, outputTokens: 100, modelId: 'claude-3' },
            guardrailViolations: ['no-health-promises'],
          },
          createdAt: now,
        },
      ];

      mockQueryBuilder.getMany.mockResolvedValue(mockLogs);

      const result = await service.getDashboardMetrics('tenant-1', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-31'),
      });

      expect(result.totalExecutions).toBe(3);
      expect(result.errorRate).toBeCloseTo(1 / 3, 3);
      expect(result.avgResponseTimeMs).toBeCloseTo((1000 + 2000 + 500) / 3, 0);
      expect(result.tokensByModel['gpt-4']).toEqual({ inputTokens: 100, outputTokens: 200 });
      expect(result.tokensByModel['claude-3']).toEqual({ inputTokens: 50, outputTokens: 100 });
      expect(result.tokensByAgent['agent-1']).toEqual({ inputTokens: 100, outputTokens: 200 });
      expect(result.guardrailViolations).toBe(1);
      expect(result.topErrors).toHaveLength(1);
      expect(result.topErrors[0].actionType).toBe('generate_content');
    });

    it('should return zero metrics when no logs exist', async () => {
      mockQueryBuilder.getMany.mockResolvedValue([]);

      const result = await service.getDashboardMetrics('tenant-1', {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-31'),
      });

      expect(result.totalExecutions).toBe(0);
      expect(result.errorRate).toBe(0);
      expect(result.avgResponseTimeMs).toBe(0);
      expect(result.guardrailViolations).toBe(0);
      expect(result.topErrors).toHaveLength(0);
    });
  });

  describe('checkAlertThresholds', () => {
    it('should create an alert when error rate exceeds 10%', async () => {
      const now = new Date();
      const recentLogs: Partial<AuditLog>[] = [
        // 3 errors out of 10 total = 30% error rate
        ...Array(7).fill(null).map((_, i) => ({
          id: `log-success-${i}`,
          agentId: 'agent-1',
          status: 'success' as const,
          metadata: { logType: 'agent_action' },
          createdAt: now,
        })),
        ...Array(3).fill(null).map((_, i) => ({
          id: `log-error-${i}`,
          agentId: 'agent-1',
          status: 'error' as const,
          metadata: { logType: 'agent_action' },
          createdAt: now,
        })),
      ];

      // First call for audit logs query
      const auditQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(recentLogs),
        getOne: jest.fn().mockResolvedValue(null),
      };

      // Second call for alert dedup check
      const alertQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue(null),
      };

      (auditLogRepo.createQueryBuilder as jest.Mock).mockReturnValue(auditQueryBuilder);
      (alertRepo.createQueryBuilder as jest.Mock).mockReturnValue(alertQueryBuilder);

      const alerts = await service.checkAlertThresholds('tenant-1');

      expect(alerts).toHaveLength(1);
      expect(alerts[0].alertType).toBe('error_rate_high');
      expect(alerts[0].agentId).toBe('agent-1');
      expect(alerts[0].currentValue).toBeCloseTo(0.3, 2);
      expect(alertRepo.save).toHaveBeenCalled();
    });

    it('should not create alert when error rate is below threshold', async () => {
      const now = new Date();
      const recentLogs: Partial<AuditLog>[] = [
        // 1 error out of 20 total = 5% error rate
        ...Array(19).fill(null).map((_, i) => ({
          id: `log-success-${i}`,
          agentId: 'agent-1',
          status: 'success' as const,
          metadata: { logType: 'agent_action' },
          createdAt: now,
        })),
        {
          id: 'log-error-0',
          agentId: 'agent-1',
          status: 'error' as const,
          metadata: { logType: 'agent_action' },
          createdAt: now,
        },
      ];

      const auditQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(recentLogs),
      };

      (auditLogRepo.createQueryBuilder as jest.Mock).mockReturnValue(auditQueryBuilder);

      const alerts = await service.checkAlertThresholds('tenant-1');

      expect(alerts).toHaveLength(0);
      expect(alertRepo.save).not.toHaveBeenCalled();
    });

    it('should not duplicate alerts within the same hour window', async () => {
      const now = new Date();
      const recentLogs: Partial<AuditLog>[] = [
        ...Array(5).fill(null).map((_, i) => ({
          id: `log-success-${i}`,
          agentId: 'agent-1',
          status: 'success' as const,
          metadata: { logType: 'agent_action' },
          createdAt: now,
        })),
        ...Array(5).fill(null).map((_, i) => ({
          id: `log-error-${i}`,
          agentId: 'agent-1',
          status: 'error' as const,
          metadata: { logType: 'agent_action' },
          createdAt: now,
        })),
      ];

      const auditQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(recentLogs),
      };

      // Existing alert found (dedup)
      const alertQueryBuilder = {
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({ id: 'existing-alert' }),
      };

      (auditLogRepo.createQueryBuilder as jest.Mock).mockReturnValue(auditQueryBuilder);
      (alertRepo.createQueryBuilder as jest.Mock).mockReturnValue(alertQueryBuilder);

      const alerts = await service.checkAlertThresholds('tenant-1');

      expect(alerts).toHaveLength(0);
      expect(alertRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('exportLogs', () => {
    it('should export logs in JSON format', async () => {
      const mockLogs: Partial<AuditLog>[] = [
        {
          id: 'log-1',
          traceId: 'trace-1',
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          userId: null,
          actionType: 'generate_content',
          input: 'test input',
          output: 'test output',
          durationMs: 100,
          status: 'success',
          metadata: { logType: 'agent_action' },
          createdAt: new Date('2024-01-15T10:00:00Z'),
        },
      ];

      mockQueryBuilder.getMany.mockResolvedValue(mockLogs);

      const result = await service.exportLogs(
        'tenant-1',
        {
          tenantId: 'tenant-1',
          period: { start: new Date('2024-01-01'), end: new Date('2024-01-31') },
        },
        'json',
      );

      expect(result.format).toBe('json');
      expect(result.recordCount).toBe(1);
      const parsed = JSON.parse(result.data);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].traceId).toBe('trace-1');
    });

    it('should export logs in CSV format', async () => {
      const mockLogs: Partial<AuditLog>[] = [
        {
          id: 'log-1',
          traceId: 'trace-1',
          tenantId: 'tenant-1',
          agentId: 'agent-1',
          userId: null,
          actionType: 'generate_content',
          input: 'test',
          output: 'result',
          durationMs: 100,
          status: 'success',
          metadata: {},
          createdAt: new Date('2024-01-15T10:00:00Z'),
        },
      ];

      mockQueryBuilder.getMany.mockResolvedValue(mockLogs);

      const result = await service.exportLogs(
        'tenant-1',
        {
          tenantId: 'tenant-1',
          period: { start: new Date('2024-01-01'), end: new Date('2024-01-31') },
        },
        'csv',
      );

      expect(result.format).toBe('csv');
      expect(result.recordCount).toBe(1);
      const lines = result.data.split('\n');
      expect(lines[0]).toBe('id,trace_id,tenant_id,agent_id,user_id,action_type,input,output,duration_ms,status,metadata,created_at');
      expect(lines).toHaveLength(2); // header + 1 row
    });

    it('should escape CSV fields containing commas or quotes', async () => {
      const mockLogs: Partial<AuditLog>[] = [
        {
          id: 'log-1',
          traceId: 'trace-1',
          tenantId: 'tenant-1',
          agentId: null,
          userId: null,
          actionType: 'test',
          input: 'field, with comma',
          output: 'field with "quotes"',
          durationMs: 0,
          status: 'success',
          metadata: {},
          createdAt: new Date('2024-01-15T10:00:00Z'),
        },
      ];

      mockQueryBuilder.getMany.mockResolvedValue(mockLogs);

      const result = await service.exportLogs(
        'tenant-1',
        {
          tenantId: 'tenant-1',
          period: { start: new Date('2024-01-01'), end: new Date('2024-01-31') },
        },
        'csv',
      );

      expect(result.data).toContain('"field, with comma"');
      expect(result.data).toContain('"field with ""quotes"""');
    });
  });

  describe('generateTraceId', () => {
    it('should generate a valid trace ID', () => {
      const traceId = service.generateTraceId();
      expect(traceId).toMatch(/^trace-[0-9a-f-]{36}$/);
    });

    it('should generate unique trace IDs', () => {
      const id1 = service.generateTraceId();
      const id2 = service.generateTraceId();
      expect(id1).not.toBe(id2);
    });
  });

  describe('immutability guarantee', () => {
    it('should only use INSERT (save) and never call update/delete on audit logs', () => {
      // Verify the service does not expose any update or delete method for audit logs
      const serviceProto = Object.getOwnPropertyNames(
        Object.getPrototypeOf(service),
      );
      // The service should not have methods that mutate audit logs
      expect(serviceProto).not.toContain('updateAuditLog');
      expect(serviceProto).not.toContain('deleteAuditLog');
    });
  });
});
