import * as fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';
import { ObservabilityService } from '../services/observability.service';
import { AuditLog } from '../entities/audit-log.entity';
import { AgentLogEntry } from '../interfaces/observability-service.interface';

/**
 * Property 25: Audit Log — Completude e Imutabilidade
 *
 * Execute actions, verify log records contain ALL required fields;
 * verify that the service ONLY calls repository.create + repository.save (never update/delete),
 * proving immutability at the service level.
 *
 * **Validates: Requirements 13.1, 13.2, 13.3, 13.7**
 */

// ----- In-memory repository mocks -----

interface SavedAuditLog {
  id: string;
  traceId: string;
  tenantId: string;
  agentId: string | null;
  userId: string | null;
  actionType: string;
  input: string;
  output: string;
  durationMs: number;
  status: string;
  metadata: Record<string, any>;
  createdAt: Date;
}

interface MockAuditLogRepo {
  savedEntries: SavedAuditLog[];
  create: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  delete: jest.Mock;
  remove: jest.Mock;
  createQueryBuilder: jest.Mock;
}

interface MockAlertRepo {
  create: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
}

function createMockAuditLogRepo(): MockAuditLogRepo {
  const savedEntries: SavedAuditLog[] = [];

  return {
    savedEntries,
    create: jest.fn().mockImplementation((data) => ({
      id: uuidv4(),
      createdAt: new Date(),
      ...data,
    })),
    save: jest.fn().mockImplementation(async (entry) => {
      const saved = { id: entry.id || uuidv4(), createdAt: entry.createdAt || new Date(), ...entry };
      savedEntries.push(saved);
      return saved;
    }),
    update: jest.fn().mockImplementation(() => {
      throw new Error('UPDATE not allowed on audit_logs — immutability violated');
    }),
    delete: jest.fn().mockImplementation(() => {
      throw new Error('DELETE not allowed on audit_logs — immutability violated');
    }),
    remove: jest.fn().mockImplementation(() => {
      throw new Error('REMOVE not allowed on audit_logs — immutability violated');
    }),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
      getMany: jest.fn().mockResolvedValue([]),
      getOne: jest.fn().mockResolvedValue(null),
    }),
  };
}

function createMockAlertRepo(): MockAlertRepo {
  return {
    create: jest.fn().mockImplementation((data) => ({ id: uuidv4(), triggeredAt: new Date(), ...data })),
    save: jest.fn().mockImplementation(async (data) => ({ id: uuidv4(), triggeredAt: new Date(), ...data })),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    }),
  };
}

function createService(auditLogRepo: MockAuditLogRepo, alertRepo: MockAlertRepo): ObservabilityService {
  return new ObservabilityService(auditLogRepo as any, alertRepo as any);
}

// ----- Arbitraries -----

const actionTypeArb = fc.constantFrom(
  'generate_content',
  'generate_campaign',
  'answer_customer',
  'rag_query',
  'schedule_post',
  'analyze_metrics',
  'suggest_caption',
);

const statusArb = fc.constantFrom('success', 'error') as fc.Arbitrary<'success' | 'error'>;

const guardrailViolationsArb = fc.array(
  fc.constantFrom(
    'no-health-promises',
    'no-diagnoses',
    'no-prescriptions',
    'no-anvisa-violations',
    'no-cross-tenant-sharing',
  ),
  { minLength: 0, maxLength: 3 },
);

const agentLogEntryArb = fc.record({
  traceId: fc.oneof(
    fc.constant(''),
    fc.uuid().map((id) => `trace-${id}`),
  ),
  tenantId: fc.uuid(),
  agentId: fc.uuid(),
  actionType: actionTypeArb,
  input: fc.string({ minLength: 1, maxLength: 200 }),
  output: fc.string({ minLength: 1, maxLength: 500 }),
  durationMs: fc.integer({ min: 0, max: 30000 }),
  status: statusArb,
  tokensUsed: fc.option(
    fc.record({
      inputTokens: fc.integer({ min: 0, max: 10000 }),
      outputTokens: fc.integer({ min: 0, max: 10000 }),
      modelId: fc.constantFrom('gpt-4', 'gpt-4o', 'claude-3-sonnet', 'gemini-pro'),
      agentId: fc.uuid(),
      timestamp: fc.date(),
    }),
    { nil: undefined },
  ),
  guardrailViolations: guardrailViolationsArb,
  timestamp: fc.date(),
}) as fc.Arbitrary<AgentLogEntry>;

// ----- Tests -----

describe('Property 25: Audit Log — Completude e Imutabilidade', () => {
  it('should contain ALL required fields in every saved audit log entry', async () => {
    await fc.assert(
      fc.asyncProperty(agentLogEntryArb, async (entry) => {
        const auditLogRepo = createMockAuditLogRepo();
        const alertRepo = createMockAlertRepo();
        const service = createService(auditLogRepo, alertRepo);

        await service.logAgentAction(entry);

        // Verify exactly one entry was saved
        expect(auditLogRepo.savedEntries.length).toBe(1);

        const saved = auditLogRepo.savedEntries[0];

        // Verify ALL required fields are present and defined
        expect(saved.id).toBeDefined();
        expect(typeof saved.id).toBe('string');
        expect(saved.id.length).toBeGreaterThan(0);

        expect(saved.traceId).toBeDefined();
        expect(typeof saved.traceId).toBe('string');
        expect(saved.traceId.length).toBeGreaterThan(0);

        expect(saved.tenantId).toBeDefined();
        expect(typeof saved.tenantId).toBe('string');

        expect(saved.agentId).toBeDefined();
        expect(typeof saved.agentId).toBe('string');

        expect(saved.actionType).toBeDefined();
        expect(typeof saved.actionType).toBe('string');

        expect(saved.input).toBeDefined();
        expect(typeof saved.input).toBe('string');

        expect(saved.output).toBeDefined();
        expect(typeof saved.output).toBe('string');

        expect(saved.durationMs).toBeDefined();
        expect(typeof saved.durationMs).toBe('number');
        expect(saved.durationMs).toBeGreaterThanOrEqual(0);

        expect(saved.status).toBeDefined();
        expect(['success', 'error']).toContain(saved.status);

        expect(saved.metadata).toBeDefined();
        expect(typeof saved.metadata).toBe('object');

        expect(saved.createdAt).toBeDefined();
        expect(saved.createdAt).toBeInstanceOf(Date);
      }),
      { numRuns: 100 },
    );
  });

  it('should always have traceId present (generated if not provided)', async () => {
    await fc.assert(
      fc.asyncProperty(agentLogEntryArb, async (entry) => {
        const auditLogRepo = createMockAuditLogRepo();
        const alertRepo = createMockAlertRepo();
        const service = createService(auditLogRepo, alertRepo);

        await service.logAgentAction(entry);

        const saved = auditLogRepo.savedEntries[0];

        // traceId must always be non-empty
        expect(saved.traceId).toBeDefined();
        expect(saved.traceId.length).toBeGreaterThan(0);

        // If the input had a traceId, it should be preserved
        if (entry.traceId && entry.traceId.length > 0) {
          expect(saved.traceId).toBe(entry.traceId);
        } else {
          // If empty, a new one should be generated with the trace- prefix
          expect(saved.traceId).toMatch(/^trace-/);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('should ONLY call repository.create and repository.save (never update/delete) — proving immutability', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(agentLogEntryArb, { minLength: 1, maxLength: 5 }),
        async (entries) => {
          const auditLogRepo = createMockAuditLogRepo();
          const alertRepo = createMockAlertRepo();
          const service = createService(auditLogRepo, alertRepo);

          // Log multiple actions
          for (const entry of entries) {
            await service.logAgentAction(entry);
          }

          // Verify create was called for each entry
          expect(auditLogRepo.create).toHaveBeenCalledTimes(entries.length);

          // Verify save was called for each entry
          expect(auditLogRepo.save).toHaveBeenCalledTimes(entries.length);

          // Verify update, delete, and remove were NEVER called
          expect(auditLogRepo.update).not.toHaveBeenCalled();
          expect(auditLogRepo.delete).not.toHaveBeenCalled();
          expect(auditLogRepo.remove).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should preserve correct field values from the input entry', async () => {
    await fc.assert(
      fc.asyncProperty(agentLogEntryArb, async (entry) => {
        const auditLogRepo = createMockAuditLogRepo();
        const alertRepo = createMockAlertRepo();
        const service = createService(auditLogRepo, alertRepo);

        await service.logAgentAction(entry);

        const saved = auditLogRepo.savedEntries[0];

        // Core fields must match input
        expect(saved.tenantId).toBe(entry.tenantId);
        expect(saved.agentId).toBe(entry.agentId);
        expect(saved.actionType).toBe(entry.actionType);
        expect(saved.input).toBe(entry.input);
        expect(saved.output).toBe(entry.output);
        expect(saved.durationMs).toBe(entry.durationMs);
        expect(saved.status).toBe(entry.status);

        // Metadata must include logType
        expect(saved.metadata.logType).toBe('agent_action');

        // If tokens were provided, they must be in metadata
        if (entry.tokensUsed) {
          expect(saved.metadata.tokensUsed).toBeDefined();
          expect(saved.metadata.tokensUsed.inputTokens).toBe(entry.tokensUsed.inputTokens);
          expect(saved.metadata.tokensUsed.outputTokens).toBe(entry.tokensUsed.outputTokens);
          expect(saved.metadata.tokensUsed.modelId).toBe(entry.tokensUsed.modelId);
        }

        // If guardrail violations were provided and non-empty, they must be in metadata
        if (entry.guardrailViolations && entry.guardrailViolations.length > 0) {
          expect(saved.metadata.guardrailViolations).toEqual(entry.guardrailViolations);
        }
      }),
      { numRuns: 100 },
    );
  });
});
