import * as fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentMemoryService, SHORT_TERM_LIMIT } from '../services/agent-memory.service';
import { AgentMemoryShort } from '../entities/agent-memory-short.entity';
import { AgentMemoryLong } from '../entities/agent-memory-long.entity';
import { Interaction } from '../interfaces/agent-memory.interface';

/**
 * Property 10: Memória do Agente — Persistência Round-Trip
 *
 * 1. Generate N random interactions (role, content), persist them, then load context
 *    → verify content is identical for recent ones.
 * 2. After persisting any number of interactions, short-term count is always ≤ 50.
 * 3. Content integrity: what goes in must come out unchanged.
 *
 * **Validates: Requirements 7.3, 7.4, 7.7**
 */

// ----- Arbitraries -----

const roleArb = fc.constantFrom<'user' | 'assistant' | 'system'>('user', 'assistant', 'system');

const contentArb = fc.string({ minLength: 1, maxLength: 500 });

const interactionArb = fc.record({
  role: roleArb,
  content: contentArb,
});

// Generate N interactions (1 to 80, to test beyond the 50 limit)
const interactionsArb = fc.array(interactionArb, { minLength: 1, maxLength: 80 });

// ----- In-memory store simulating repository behavior -----

interface InMemoryStore {
  shortTerm: AgentMemoryShort[];
  longTerm: AgentMemoryLong[];
}

function createInMemoryRepos(store: InMemoryStore) {
  // Use a monotonically increasing counter to ensure unique ordering
  let createdAtCounter = 0;

  const shortTermRepo = {
    create: jest.fn().mockImplementation((data: Partial<AgentMemoryShort>) => ({
      id: uuidv4(),
      agentId: data.agentId,
      tenantId: data.tenantId,
      role: data.role,
      content: data.content,
      metadata: data.metadata || null,
      createdAt: new Date(1700000000000 + ++createdAtCounter),
    })),
    save: jest.fn().mockImplementation(async (entity: AgentMemoryShort) => {
      store.shortTerm.push(entity);
      return entity;
    }),
    count: jest.fn().mockImplementation(async ({ where }: any) => {
      return store.shortTerm.filter(
        (r) => r.agentId === where.agentId && r.tenantId === where.tenantId,
      ).length;
    }),
    find: jest.fn().mockImplementation(async (opts: any) => {
      const { where, order, take } = opts;
      let results = store.shortTerm.filter(
        (r) => r.agentId === where.agentId && (!where.tenantId || r.tenantId === where.tenantId),
      );

      // Sort
      if (order?.createdAt === 'DESC') {
        results = [...results].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      } else if (order?.createdAt === 'ASC') {
        results = [...results].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      }

      // Limit
      if (take) {
        results = results.slice(0, take);
      }

      return results;
    }),
    findOne: jest.fn().mockImplementation(async (opts: any) => {
      const { where } = opts;
      const match = store.shortTerm.find((r) => r.agentId === where.agentId);
      return match || null;
    }),
    remove: jest.fn().mockImplementation(async (entities: AgentMemoryShort[]) => {
      const ids = new Set(entities.map((e) => e.id));
      store.shortTerm = store.shortTerm.filter((r) => !ids.has(r.id));
      return entities;
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

  const longTermRepo = {
    create: jest.fn().mockImplementation((data: Partial<AgentMemoryLong>) => ({
      id: uuidv4(),
      agentId: data.agentId,
      tenantId: data.tenantId,
      type: data.type || 'learning',
      summary: data.summary,
      confidence: data.confidence ?? 0.7,
      sourceInteractions: data.sourceInteractions || [],
      createdAt: new Date(),
    })),
    save: jest.fn().mockImplementation(async (entity: AgentMemoryLong) => {
      store.longTerm.push(entity);
      return entity;
    }),
    find: jest.fn().mockImplementation(async (opts: any) => {
      const { where } = opts;
      return store.longTerm.filter(
        (r) => r.agentId === where.agentId && (!where.tenantId || r.tenantId === where.tenantId),
      );
    }),
    findOne: jest.fn(),
    count: jest.fn(),
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

  return { shortTermRepo, longTermRepo };
}

async function createServiceWithStore(store: InMemoryStore) {
  const { shortTermRepo, longTermRepo } = createInMemoryRepos(store);

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      AgentMemoryService,
      { provide: getRepositoryToken(AgentMemoryShort), useValue: shortTermRepo },
      { provide: getRepositoryToken(AgentMemoryLong), useValue: longTermRepo },
    ],
  }).compile();

  return module.get<AgentMemoryService>(AgentMemoryService);
}

// ----- Tests -----

describe('Property 10: Memória do Agente — Persistência Round-Trip', () => {
  it('persisted interactions are recovered with identical content (round-trip)', async () => {
    await fc.assert(
      fc.asyncProperty(interactionsArb, async (interactions) => {
        const store: InMemoryStore = { shortTerm: [], longTerm: [] };
        const service = await createServiceWithStore(store);
        const agentId = uuidv4();
        const tenantId = uuidv4();

        // Persist all interactions sequentially with unique timestamps
        for (let i = 0; i < interactions.length; i++) {
          await service.persistInteraction(agentId, {
            agentId,
            tenantId,
            role: interactions[i].role,
            content: interactions[i].content,
            timestamp: new Date(Date.now() + i),
          });
        }

        // Load context
        const context = await service.loadContext(agentId, tenantId);

        // The most recent interactions (up to 50) should be present
        const expectedRecent = interactions.slice(-SHORT_TERM_LIMIT);

        // Verify content integrity: recent interactions should have identical content
        // Context is ordered DESC (most recent first), so reverse to compare
        const loadedContents = context.shortTerm.map((i) => i.content).reverse();
        const expectedContents = expectedRecent.map((i) => i.content);

        expect(loadedContents).toEqual(expectedContents);

        // Also verify roles match
        const loadedRoles = context.shortTerm.map((i) => i.role).reverse();
        const expectedRoles = expectedRecent.map((i) => i.role);

        expect(loadedRoles).toEqual(expectedRoles);
      }),
      { numRuns: 100 },
    );
  });

  it('short-term memory count never exceeds SHORT_TERM_LIMIT (50) after any number of persists', async () => {
    await fc.assert(
      fc.asyncProperty(interactionsArb, async (interactions) => {
        const store: InMemoryStore = { shortTerm: [], longTerm: [] };
        const service = await createServiceWithStore(store);
        const agentId = uuidv4();
        const tenantId = uuidv4();

        // Persist all interactions
        for (let i = 0; i < interactions.length; i++) {
          await service.persistInteraction(agentId, {
            agentId,
            tenantId,
            role: interactions[i].role,
            content: interactions[i].content,
            timestamp: new Date(Date.now() + i),
          });
        }

        // Verify short-term count is always within limit
        const shortTermMemory = await service.getShortTermMemory(agentId, tenantId);
        expect(shortTermMemory.length).toBeLessThanOrEqual(SHORT_TERM_LIMIT);

        // Also verify via loadContext metadata
        const context = await service.loadContext(agentId, tenantId);
        expect(context.metadata.shortTermCount).toBeLessThanOrEqual(SHORT_TERM_LIMIT);
      }),
      { numRuns: 100 },
    );
  });

  it('content integrity: what goes in must come out unchanged for all retained interactions', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(interactionArb, { minLength: 1, maxLength: 50 }),
        async (interactions) => {
          const store: InMemoryStore = { shortTerm: [], longTerm: [] };
          const service = await createServiceWithStore(store);
          const agentId = uuidv4();
          const tenantId = uuidv4();

          // Persist interactions (within limit, so all should be retained)
          for (let i = 0; i < interactions.length; i++) {
            await service.persistInteraction(agentId, {
              agentId,
              tenantId,
              role: interactions[i].role,
              content: interactions[i].content,
              timestamp: new Date(Date.now() + i),
            });
          }

          // Load and verify every single interaction is present with exact content
          const context = await service.loadContext(agentId, tenantId);

          expect(context.shortTerm.length).toBe(interactions.length);

          // Verify each interaction's content and role are byte-for-byte identical
          // Context returns DESC order, so reverse for comparison
          const loaded = [...context.shortTerm].reverse();

          for (let i = 0; i < interactions.length; i++) {
            expect(loaded[i].content).toBe(interactions[i].content);
            expect(loaded[i].role).toBe(interactions[i].role);
            expect(loaded[i].agentId).toBe(agentId);
            expect(loaded[i].tenantId).toBe(tenantId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
