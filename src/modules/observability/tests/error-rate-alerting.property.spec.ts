import * as fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';
import { ObservabilityService } from '../services/observability.service';
import { AuditLog } from '../entities/audit-log.entity';

/**
 * Property 27: Alerta de Taxa de Erro
 *
 * When agent error rate exceeds 10% within a 1-hour window, an alert MUST be triggered.
 * When error rate is ≤ 10%, NO alert should be triggered.
 * The threshold is strictly greater than (>), so exactly 10% does NOT trigger an alert.
 *
 * **Validates: Requirements 13.6**
 */

// ----- Constants matching the service -----
const ERROR_RATE_THRESHOLD = 0.10;

// ----- Helper to create mock audit logs with a specific error rate -----

function createAgentLogs(
  tenantId: string,
  agentId: string,
  totalActions: number,
  errorCount: number,
): Partial<AuditLog>[] {
  const logs: Partial<AuditLog>[] = [];
  const now = new Date();

  for (let i = 0; i < totalActions; i++) {
    logs.push({
      id: uuidv4(),
      traceId: `trace-${uuidv4()}`,
      tenantId,
      agentId,
      userId: null,
      actionType: 'generate_content',
      input: `input_${i}`,
      output: `output_${i}`,
      durationMs: 100 + i,
      status: i < errorCount ? 'error' : 'success',
      metadata: { logType: 'agent_action' },
      createdAt: new Date(now.getTime() - (i * 1000)), // within last hour
    });
  }

  return logs;
}

// ----- Mock repository factory -----

function createMockRepos(recentLogs: Partial<AuditLog>[] = []) {
  const savedAlerts: any[] = [];

  const auditLogRepo = {
    create: jest.fn().mockImplementation((data: any) => ({
      id: uuidv4(),
      createdAt: new Date(),
      ...data,
    })),
    save: jest.fn().mockImplementation(async (data: any) => data),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(recentLogs.length),
      getMany: jest.fn().mockResolvedValue(recentLogs),
      getOne: jest.fn().mockResolvedValue(null),
    }),
  };

  const alertRepo = {
    create: jest.fn().mockImplementation((data: any) => ({
      id: uuidv4(),
      triggeredAt: new Date(),
      ...data,
    })),
    save: jest.fn().mockImplementation(async (data: any) => {
      savedAlerts.push(data);
      return data;
    }),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null), // No existing alert (no deduplication block)
    }),
  };

  return { auditLogRepo, alertRepo, savedAlerts };
}

function createService(auditLogRepo: any, alertRepo: any): ObservabilityService {
  return new ObservabilityService(auditLogRepo, alertRepo);
}

// ----- Arbitraries -----

const tenantIdArb = fc.uuid();
const agentIdArb = fc.uuid();

// Total actions between 10 and 100 to ensure meaningful error rate calculations
const totalActionsArb = fc.integer({ min: 10, max: 100 });

// ----- Tests -----

describe('Property 27: Alerta de Taxa de Erro', () => {
  it('should trigger alert when error rate > 10%', async () => {
    await fc.assert(
      fc.asyncProperty(
        tenantIdArb,
        agentIdArb,
        totalActionsArb,
        async (tenantId, agentId, totalActions) => {
          // Generate error count that results in error rate > 10%
          // Minimum errors needed: Math.floor(totalActions * 0.10) + 1
          const minErrors = Math.floor(totalActions * ERROR_RATE_THRESHOLD) + 1;
          const errorCount = minErrors + Math.floor(Math.random() * (totalActions - minErrors));

          const logs = createAgentLogs(tenantId, agentId, totalActions, errorCount);
          const { auditLogRepo, alertRepo, savedAlerts } = createMockRepos(logs);
          const service = createService(auditLogRepo, alertRepo);

          const alerts = await service.checkAlertThresholds(tenantId);

          // Verify alert was triggered
          expect(alerts.length).toBe(1);
          expect(alerts[0].agentId).toBe(agentId);
          expect(alerts[0].alertType).toBe('error_rate_high');
          expect(alerts[0].threshold).toBe(ERROR_RATE_THRESHOLD);
          expect(alerts[0].currentValue).toBeGreaterThan(ERROR_RATE_THRESHOLD);
          expect(alerts[0].tenantId).toBe(tenantId);
          expect(alerts[0].message).toBeDefined();
          expect(alerts[0].message.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should NOT trigger alert when error rate ≤ 10%', async () => {
    await fc.assert(
      fc.asyncProperty(
        tenantIdArb,
        agentIdArb,
        totalActionsArb,
        async (tenantId, agentId, totalActions) => {
          // Generate error count that results in error rate ≤ 10%
          const maxErrors = Math.floor(totalActions * ERROR_RATE_THRESHOLD);
          const errorCount = Math.floor(Math.random() * (maxErrors + 1));

          const logs = createAgentLogs(tenantId, agentId, totalActions, errorCount);
          const { auditLogRepo, alertRepo, savedAlerts } = createMockRepos(logs);
          const service = createService(auditLogRepo, alertRepo);

          const alerts = await service.checkAlertThresholds(tenantId);

          // Verify no alert was triggered
          expect(alerts.length).toBe(0);
          expect(savedAlerts.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should NOT trigger alert at exactly 10% error rate (boundary)', async () => {
    await fc.assert(
      fc.asyncProperty(
        tenantIdArb,
        agentIdArb,
        // Use multiples of 10 so exactly 10% is possible (integer error counts)
        fc.integer({ min: 1, max: 10 }).map((n) => n * 10),
        async (tenantId, agentId, totalActions) => {
          // Exactly 10% errors
          const errorCount = totalActions / 10;

          const logs = createAgentLogs(tenantId, agentId, totalActions, errorCount);
          const { auditLogRepo, alertRepo, savedAlerts } = createMockRepos(logs);
          const service = createService(auditLogRepo, alertRepo);

          const alerts = await service.checkAlertThresholds(tenantId);

          // Exactly 10% should NOT trigger (threshold is strictly >)
          expect(alerts.length).toBe(0);
          expect(savedAlerts.length).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should trigger alert at 11% error rate (just above threshold)', async () => {
    await fc.assert(
      fc.asyncProperty(
        tenantIdArb,
        agentIdArb,
        // Use multiples of 100 so 11% is exact (integer error counts)
        fc.integer({ min: 1, max: 5 }).map((n) => n * 100),
        async (tenantId, agentId, totalActions) => {
          // Exactly 11% errors
          const errorCount = Math.round(totalActions * 0.11);

          const logs = createAgentLogs(tenantId, agentId, totalActions, errorCount);
          const { auditLogRepo, alertRepo, savedAlerts } = createMockRepos(logs);
          const service = createService(auditLogRepo, alertRepo);

          const alerts = await service.checkAlertThresholds(tenantId);

          // 11% should trigger (> 10%)
          expect(alerts.length).toBe(1);
          expect(alerts[0].agentId).toBe(agentId);
          expect(alerts[0].alertType).toBe('error_rate_high');
          expect(alerts[0].threshold).toBe(ERROR_RATE_THRESHOLD);
          expect(alerts[0].currentValue).toBeGreaterThan(ERROR_RATE_THRESHOLD);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should include correct alert information (agentId, error rate, threshold)', async () => {
    await fc.assert(
      fc.asyncProperty(
        tenantIdArb,
        agentIdArb,
        totalActionsArb,
        async (tenantId, agentId, totalActions) => {
          // Use a clear error rate above threshold (e.g., ~20%)
          const errorCount = Math.max(
            Math.floor(totalActions * ERROR_RATE_THRESHOLD) + 1,
            Math.floor(totalActions * 0.2),
          );
          const actualErrorCount = Math.min(errorCount, totalActions);

          const logs = createAgentLogs(tenantId, agentId, totalActions, actualErrorCount);
          const { auditLogRepo, alertRepo, savedAlerts } = createMockRepos(logs);
          const service = createService(auditLogRepo, alertRepo);

          const alerts = await service.checkAlertThresholds(tenantId);

          expect(alerts.length).toBe(1);
          const alert = alerts[0];

          // Verify correct agent information
          expect(alert.agentId).toBe(agentId);
          expect(alert.tenantId).toBe(tenantId);

          // Verify threshold is the configured value
          expect(alert.threshold).toBe(ERROR_RATE_THRESHOLD);

          // Verify currentValue matches computed error rate
          const expectedErrorRate = Math.round((actualErrorCount / totalActions) * 10000) / 10000;
          expect(alert.currentValue).toBe(expectedErrorRate);

          // Verify alert type
          expect(alert.alertType).toBe('error_rate_high');

          // Verify message contains relevant details
          expect(alert.message).toContain(agentId);
          expect(alert.message).toContain('10');

          // Verify triggeredAt is a valid date
          expect(alert.triggeredAt).toBeInstanceOf(Date);
        },
      ),
      { numRuns: 100 },
    );
  });
});
