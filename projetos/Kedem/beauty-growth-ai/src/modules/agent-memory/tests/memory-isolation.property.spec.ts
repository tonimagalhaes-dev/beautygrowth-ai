import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as fc from 'fast-check';

import { AgentMemoryService } from '../services/agent-memory.service';
import { AgentMemoryShort } from '../entities/agent-memory-short.entity';
import { AgentMemoryLong } from '../entities/agent-memory-long.entity';

/**
 * Property 12: Isolamento de Memória Entre Agentes
 *
 * Two agents in the same tenant — verify reads/writes never cross boundaries.
 * All memory queries filter by agentId. No data leakage between agents.
 *
 * **Validates: Requirements 7.6**
 */
describe('Property 12: Isolamento de Memória Entre Agentes', () => {
  let service: AgentMemoryService;

  // In-memory stores simulating the database
  let shortTermStore: AgentMemoryShort[];
  let longTermStore: AgentMemoryLong[];

  let shortTermRepo: any;
  let longTermRepo: any;

  beforeEach(async () => {
    shortTermStore = [];
    longTermStore = [];

    shortTermRepo = {
      find: jest.fn((options: any) => {
        const where = options?.where || {};
        let filtered = shortTermStore.filter((r) => {
          let match = true;
          if (where.agentId) match = match && r.agentId === where.agentId;
          if (where.tenantId) match = match && r.tenantId === where.tenantId;
          return match;
        });
        if (options?.order?.createdAt === 'ASC') {
          filtered = filtered.sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
          );
        } else {
          filtered = filtered.sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
          );
        }
        if (options?.take) {
          filtered = filtered.slice(0, options.take);
        }
        return Promise.resolve(filtered);
      }),
      findOne: jest.fn((options: any) => {
        const where = options?.where || {};
        const found = shortTermStore.find((r) => {
          let match = true;
          if (where.agentId) match = match && r.agentId === where.agentId;
          if (where.tenantId) match = match && r.tenantId === where.tenantId;
          return match;
        });
        return Promise.resolve(found || null);
      }),
      count: jest.fn((options: any) => {
        const where = options?.where || {};
        const count = shortTermStore.filter((r) => {
          let match = true;
          if (where.agentId) match = match && r.agentId === where.agentId;
          if (where.tenantId) match = match && r.tenantId === where.tenantId;
          return match;
        }).length;
        return Promise.resolve(count);
      }),
      create: jest.fn((dto: any) => {
        const entity: AgentMemoryShort = {
          id: `short-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          agentId: dto.agentId,
          tenantId: dto.tenantId,
          role: dto.role,
          content: dto.content,
          metadata: dto.metadata || null,
          createdAt: new Date(),
        };
        return entity;
      }),
      save: jest.fn((entity: AgentMemoryShort) => {
        shortTermStore.push(entity);
        return Promise.resolve(entity);
      }),
      remove: jest.fn((entities: AgentMemoryShort[]) => {
        const ids = entities.map((e) => e.id);
        shortTermStore = shortTermStore.filter((r) => !ids.includes(r.id));
        return Promise.resolve(entities);
      }),
      delete: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      })),
    };

    longTermRepo = {
      find: jest.fn((options: any) => {
        const where = options?.where || {};
        let filtered = longTermStore.filter((r) => {
          let match = true;
          if (where.agentId) match = match && r.agentId === where.agentId;
          if (where.tenantId) match = match && r.tenantId === where.tenantId;
          return match;
        });
        filtered = filtered.sort(
          (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        );
        return Promise.resolve(filtered);
      }),
      findOne: jest.fn(),
      count: jest.fn(),
      create: jest.fn((dto: any) => {
        const entity: AgentMemoryLong = {
          id: `long-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          agentId: dto.agentId,
          tenantId: dto.tenantId,
          type: dto.type,
          summary: dto.summary,
          confidence: dto.confidence,
          sourceInteractions: dto.sourceInteractions || [],
          createdAt: new Date(),
        };
        return entity;
      }),
      save: jest.fn((entity: AgentMemoryLong) => {
        longTermStore.push(entity);
        return Promise.resolve(entity);
      }),
      delete: jest.fn(),
      remove: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 0 }),
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentMemoryService,
        {
          provide: getRepositoryToken(AgentMemoryShort),
          useValue: shortTermRepo,
        },
        {
          provide: getRepositoryToken(AgentMemoryLong),
          useValue: longTermRepo,
        },
      ],
    }).compile();

    service = module.get<AgentMemoryService>(AgentMemoryService);
  });

  // Arbitrary: generates a UUID-like string for agent IDs
  const arbAgentId = fc.uuid().map((id) => `agent-${id}`);

  // Arbitrary: generates a fixed tenant ID (same tenant for both agents)
  const arbTenantId = fc.uuid().map((id) => `tenant-${id}`);

  // Arbitrary: generates interaction content
  const arbContent = fc.string({ minLength: 1, maxLength: 200 });

  // Arbitrary: generates interaction role
  const arbRole = fc.constantFrom('user', 'assistant', 'system') as fc.Arbitrary<
    'user' | 'assistant' | 'system'
  >;

  // Arbitrary: generates a list of interactions for an agent
  const arbInteractions = (minCount: number, maxCount: number) =>
    fc.array(
      fc.record({
        role: arbRole,
        content: arbContent,
      }),
      { minLength: minCount, maxLength: maxCount },
    );

  it('should ensure agent A context never contains agent B data after persisting interactions for both', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAgentId,
        arbAgentId,
        arbTenantId,
        arbInteractions(1, 10),
        arbInteractions(1, 10),
        async (agentIdA, agentIdB, tenantId, interactionsA, interactionsB) => {
          // Ensure distinct agent IDs
          fc.pre(agentIdA !== agentIdB);

          // Reset stores for each iteration
          shortTermStore = [];
          longTermStore = [];

          // Step 1: Persist interactions for agent A
          for (const interaction of interactionsA) {
            await service.persistInteraction(agentIdA, {
              agentId: agentIdA,
              tenantId,
              role: interaction.role,
              content: interaction.content,
              timestamp: new Date(),
            });
          }

          // Step 2: Persist interactions for agent B
          for (const interaction of interactionsB) {
            await service.persistInteraction(agentIdB, {
              agentId: agentIdB,
              tenantId,
              role: interaction.role,
              content: interaction.content,
              timestamp: new Date(),
            });
          }

          // Step 3: Load context for agent A
          const contextA = await service.loadContext(agentIdA, tenantId);

          // Step 4: Load context for agent B
          const contextB = await service.loadContext(agentIdB, tenantId);

          // Property: Agent A's short-term memory only contains agent A's data
          for (const interaction of contextA.shortTerm) {
            expect(interaction.agentId).toBe(agentIdA);
          }

          // Property: Agent B's short-term memory only contains agent B's data
          for (const interaction of contextB.shortTerm) {
            expect(interaction.agentId).toBe(agentIdB);
          }

          // Property: Agent A's long-term memory only contains agent A's data
          for (const entry of contextA.longTerm) {
            expect(entry.agentId).toBe(agentIdA);
          }

          // Property: Agent B's long-term memory only contains agent B's data
          for (const entry of contextB.longTerm) {
            expect(entry.agentId).toBe(agentIdB);
          }

          // Property: Metadata reflects correct agent
          expect(contextA.metadata.agentId).toBe(agentIdA);
          expect(contextB.metadata.agentId).toBe(agentIdB);

          // Property: No data leakage - counts match what was persisted
          expect(contextA.shortTerm.length).toBe(interactionsA.length);
          expect(contextB.shortTerm.length).toBe(interactionsB.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should ensure getShortTermMemory returns only the requested agent data', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAgentId,
        arbAgentId,
        arbTenantId,
        arbInteractions(1, 5),
        arbInteractions(1, 5),
        async (agentIdA, agentIdB, tenantId, interactionsA, interactionsB) => {
          fc.pre(agentIdA !== agentIdB);

          shortTermStore = [];
          longTermStore = [];

          // Persist for both agents
          for (const interaction of interactionsA) {
            await service.persistInteraction(agentIdA, {
              agentId: agentIdA,
              tenantId,
              role: interaction.role,
              content: interaction.content,
              timestamp: new Date(),
            });
          }
          for (const interaction of interactionsB) {
            await service.persistInteraction(agentIdB, {
              agentId: agentIdB,
              tenantId,
              role: interaction.role,
              content: interaction.content,
              timestamp: new Date(),
            });
          }

          // Query short-term memory for agent A only
          const memoryA = await service.getShortTermMemory(agentIdA, tenantId);

          // All returned interactions must belong to agent A
          for (const interaction of memoryA) {
            expect(interaction.agentId).toBe(agentIdA);
          }

          // None should belong to agent B
          const leakedB = memoryA.filter((i) => i.agentId === agentIdB);
          expect(leakedB).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should ensure getLongTermMemory returns only the requested agent data', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAgentId,
        arbAgentId,
        arbTenantId,
        async (agentIdA, agentIdB, tenantId) => {
          fc.pre(agentIdA !== agentIdB);

          shortTermStore = [];
          longTermStore = [];

          // Manually insert long-term entries for both agents
          longTermStore.push({
            id: 'lt-a-1',
            agentId: agentIdA,
            tenantId,
            type: 'learning',
            summary: 'Agent A learned something',
            confidence: 0.8,
            sourceInteractions: [],
            createdAt: new Date(),
          });

          longTermStore.push({
            id: 'lt-b-1',
            agentId: agentIdB,
            tenantId,
            type: 'pattern',
            summary: 'Agent B found a pattern',
            confidence: 0.9,
            sourceInteractions: [],
            createdAt: new Date(),
          });

          // Query long-term memory for agent A
          const longTermA = await service.getLongTermMemory(agentIdA, tenantId);

          // All entries must belong to agent A
          for (const entry of longTermA) {
            expect(entry.agentId).toBe(agentIdA);
          }

          // Query long-term memory for agent B
          const longTermB = await service.getLongTermMemory(agentIdB, tenantId);

          // All entries must belong to agent B
          for (const entry of longTermB) {
            expect(entry.agentId).toBe(agentIdB);
          }

          // No cross-contamination
          const leakedInA = longTermA.filter((e) => e.agentId === agentIdB);
          const leakedInB = longTermB.filter((e) => e.agentId === agentIdA);
          expect(leakedInA).toHaveLength(0);
          expect(leakedInB).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should ensure persisting interaction for agent A does not appear in agent B memory', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAgentId,
        arbAgentId,
        arbTenantId,
        arbContent,
        arbRole,
        async (agentIdA, agentIdB, tenantId, content, role) => {
          fc.pre(agentIdA !== agentIdB);

          shortTermStore = [];
          longTermStore = [];

          // Persist a single interaction for agent A
          await service.persistInteraction(agentIdA, {
            agentId: agentIdA,
            tenantId,
            role,
            content,
            timestamp: new Date(),
          });

          // Load context for agent B
          const contextB = await service.loadContext(agentIdB, tenantId);

          // Agent B should have zero short-term interactions
          expect(contextB.shortTerm).toHaveLength(0);
          expect(contextB.metadata.shortTermCount).toBe(0);

          // And no data from agent A should leak
          const leaked = contextB.shortTerm.filter(
            (i) => i.agentId === agentIdA,
          );
          expect(leaked).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});
