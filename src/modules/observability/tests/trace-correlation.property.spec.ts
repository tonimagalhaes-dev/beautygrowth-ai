import * as fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';
import { ObservabilityService } from '../services/observability.service';
import { AuditLog } from '../entities/audit-log.entity';
import { AlertEntity } from '../entities/alert.entity';
import {
  AgentLogEntry,
  UserLogEntry,
  RAGLogEntry,
} from '../interfaces/observability-service.interface';

/**
 * Property 26: Correlação de Trace End-to-End
 *
 * For any operation involving multiple components (agent + Knowledge Hub + memory + guardrails),
 * ALL generated log records MUST share the same trace_id, enabling full request tracing.
 *
 * **Validates: Requirements 13.9**
 */

// ----- In-memory repository mocks -----

interface SavedLog {
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

function createMockRepos() {
  const savedLogs: SavedLog[] = [];

  const auditLogRepo = {
    create: jest.fn().mockImplementation((data: any) => ({
      id: uuidv4(),
      createdAt: new Date(),
      ...data,
    })),
    save: jest.fn().mockImplementation(async (data: any) => {
      const log: SavedLog = {
        id: data.id || uuidv4(),
        traceId: data.traceId,
        tenantId: data.tenantId,
        agentId: data.agentId,
        userId: data.userId,
        actionType: data.actionType,
        input: data.input,
        output: data.output,
        durationMs: data.durationMs,
        status: data.status,
        metadata: data.metadata,
        createdAt: data.createdAt || new Date(),
      };
      savedLogs.push(log);
      return log;
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

  const alertRepo = {
    create: jest.fn().mockImplementation((data: any) => ({ id: uuidv4(), triggeredAt: new Date(), ...data })),
    save: jest.fn().mockResolvedValue({}),
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    }),
  };

  return { auditLogRepo, alertRepo, savedLogs };
}

function createService(auditLogRepo: any, alertRepo: any): ObservabilityService {
  return new ObservabilityService(auditLogRepo, alertRepo);
}

// ----- Arbitraries -----

const traceIdArb = fc.uuid().map((uuid) => `trace-${uuid}`);

const tenantIdArb = fc.uuid();

const agentIdArb = fc.uuid();

const userIdArb = fc.uuid();

const actionTypeArb = fc.constantFrom(
  'generate_content',
  'generate_campaign',
  'answer_question',
  'summarize_document',
  'translate_content',
);

const userActionTypeArb = fc.constantFrom(
  'update_brand',
  'upload_document',
  'configure_agent',
  'create_campaign',
  'view_dashboard',
);

const statusArb = fc.constantFrom('success', 'error') as fc.Arbitrary<'success' | 'error'>;

const durationArb = fc.integer({ min: 10, max: 10000 });

const textArb = fc.string({ minLength: 1, maxLength: 200 });

const chunkArb = fc.record({
  chunkId: fc.uuid(),
  documentId: fc.uuid(),
  score: fc.double({ min: 0.0, max: 1.0, noNaN: true }),
});

const chunksArb = fc.array(chunkArb, { minLength: 1, maxLength: 5 });

// ----- Tests -----

describe('Property 26: Correlação de Trace End-to-End', () => {
  it('should ensure ALL log entries share the same trace_id when explicitly provided', async () => {
    await fc.assert(
      fc.asyncProperty(
        traceIdArb,
        tenantIdArb,
        agentIdArb,
        userIdArb,
        actionTypeArb,
        userActionTypeArb,
        statusArb,
        durationArb,
        textArb,
        textArb,
        chunksArb,
        async (
          sharedTraceId,
          tenantId,
          agentId,
          userId,
          agentActionType,
          userActionType,
          status,
          duration,
          inputText,
          outputText,
          chunks,
        ) => {
          const { auditLogRepo, alertRepo, savedLogs } = createMockRepos();
          const service = createService(auditLogRepo, alertRepo);

          // Log an agent action with the shared traceId
          const agentEntry: AgentLogEntry = {
            traceId: sharedTraceId,
            tenantId,
            agentId,
            actionType: agentActionType,
            input: inputText,
            output: outputText,
            durationMs: duration,
            status,
            timestamp: new Date(),
          };
          await service.logAgentAction(agentEntry);

          // Log a user action with the same traceId
          const userEntry: UserLogEntry = {
            traceId: sharedTraceId,
            tenantId,
            userId,
            actionType: userActionType,
            resource: 'brand_identity',
            result: 'updated',
            timestamp: new Date(),
          };
          await service.logUserAction(userEntry);

          // Log a RAG query with the same traceId
          const ragEntry: RAGLogEntry = {
            traceId: sharedTraceId,
            tenantId,
            agentId,
            query: inputText,
            chunksReturned: chunks,
            finalPrompt: `Context: ... Question: ${inputText}`,
            response: outputText,
            durationMs: duration,
            timestamp: new Date(),
          };
          await service.logRAGQuery(ragEntry);

          // Verify: ALL saved entries share the same trace_id
          expect(savedLogs.length).toBe(3);
          for (const log of savedLogs) {
            expect(log.traceId).toBe(sharedTraceId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should auto-generate a valid trace_id when none is provided', async () => {
    await fc.assert(
      fc.asyncProperty(
        tenantIdArb,
        agentIdArb,
        actionTypeArb,
        statusArb,
        durationArb,
        textArb,
        textArb,
        async (tenantId, agentId, actionType, status, duration, inputText, outputText) => {
          const { auditLogRepo, alertRepo, savedLogs } = createMockRepos();
          const service = createService(auditLogRepo, alertRepo);

          // Log an agent action WITHOUT providing a traceId (empty string triggers auto-generation)
          const entry: AgentLogEntry = {
            traceId: '',
            tenantId,
            agentId,
            actionType,
            input: inputText,
            output: outputText,
            durationMs: duration,
            status,
            timestamp: new Date(),
          };
          await service.logAgentAction(entry);

          // Verify: auto-generated trace_id matches expected format: 'trace-<uuid>'
          expect(savedLogs.length).toBe(1);
          const generatedTraceId = savedLogs[0].traceId;
          expect(generatedTraceId).toMatch(/^trace-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should correlate different operations with the same traceId (queryable together)', async () => {
    await fc.assert(
      fc.asyncProperty(
        traceIdArb,
        tenantIdArb,
        agentIdArb,
        userIdArb,
        fc.integer({ min: 2, max: 6 }),
        async (sharedTraceId, tenantId, agentId, userId, numOperations) => {
          const { auditLogRepo, alertRepo, savedLogs } = createMockRepos();
          const service = createService(auditLogRepo, alertRepo);

          // Log multiple mixed operations with the same traceId
          for (let i = 0; i < numOperations; i++) {
            const opType = i % 3;

            if (opType === 0) {
              await service.logAgentAction({
                traceId: sharedTraceId,
                tenantId,
                agentId,
                actionType: `action_${i}`,
                input: `input_${i}`,
                output: `output_${i}`,
                durationMs: 100 + i * 10,
                status: 'success',
                timestamp: new Date(),
              });
            } else if (opType === 1) {
              await service.logUserAction({
                traceId: sharedTraceId,
                tenantId,
                userId,
                actionType: `user_action_${i}`,
                resource: `resource_${i}`,
                result: 'completed',
                timestamp: new Date(),
              });
            } else {
              await service.logRAGQuery({
                traceId: sharedTraceId,
                tenantId,
                agentId,
                query: `query_${i}`,
                chunksReturned: [{ chunkId: uuidv4(), documentId: uuidv4(), score: 0.9 }],
                finalPrompt: `prompt_${i}`,
                response: `response_${i}`,
                durationMs: 200 + i * 10,
                timestamp: new Date(),
              });
            }
          }

          // Verify: ALL logs share the same traceId and can be correlated
          expect(savedLogs.length).toBe(numOperations);

          const traceIds = savedLogs.map((log) => log.traceId);
          const uniqueTraceIds = new Set(traceIds);

          // All entries must share a single traceId
          expect(uniqueTraceIds.size).toBe(1);
          expect(traceIds[0]).toBe(sharedTraceId);

          // Verify filtering by traceId returns all correlated logs
          const correlatedLogs = savedLogs.filter((log) => log.traceId === sharedTraceId);
          expect(correlatedLogs.length).toBe(numOperations);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should generate unique auto-generated trace_ids for independent operations', async () => {
    await fc.assert(
      fc.asyncProperty(
        tenantIdArb,
        agentIdArb,
        fc.integer({ min: 2, max: 5 }),
        async (tenantId, agentId, numOps) => {
          const { auditLogRepo, alertRepo, savedLogs } = createMockRepos();
          const service = createService(auditLogRepo, alertRepo);

          // Log multiple independent operations WITHOUT providing a traceId
          for (let i = 0; i < numOps; i++) {
            await service.logAgentAction({
              traceId: '',
              tenantId,
              agentId,
              actionType: `action_${i}`,
              input: `input_${i}`,
              output: `output_${i}`,
              durationMs: 100,
              status: 'success',
              timestamp: new Date(),
            });
          }

          // Verify: each auto-generated traceId is unique (different operations = different traces)
          expect(savedLogs.length).toBe(numOps);
          const traceIds = savedLogs.map((log) => log.traceId);
          const uniqueTraceIds = new Set(traceIds);
          expect(uniqueTraceIds.size).toBe(numOps);

          // Each trace_id must be in valid format
          for (const traceId of traceIds) {
            expect(traceId).toMatch(/^trace-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
