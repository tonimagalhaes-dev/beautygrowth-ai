import * as fc from 'fast-check';
import { v4 as uuidv4 } from 'uuid';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AgentMemoryService, SHORT_TERM_LIMIT } from '../services/agent-memory.service';
import { AgentMemoryShort, InteractionRole } from '../entities/agent-memory-short.entity';
import { AgentMemoryLong } from '../entities/agent-memory-long.entity';

/**
 * Property 11: Promoção de Memória Curto → Longo Prazo
 *
 * For any agent whose short-term memory reaches 50 interactions, upon adding the 51st interaction,
 * the oldest interactions MUST be summarized and promoted to long-term memory,
 * keeping short-term memory size ≤ 50.
 *
 * **Validates: Requirements 7.4, 7.5**
 */

// ----- In-memory repository simulators -----

interface InMemoryShortTermRepo {
  records: AgentMemoryShort[];
  find: jest.Mock;
  findOne: jest.Mock;
  count: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
  delete: jest.Mock;
  createQueryBuilder: jest.Mock;
}

interface InMemoryLongTermRepo {
  records: AgentMemoryLong[];
  find: jest.Mock;
  findOne: jest.Mock;
  count: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  remove: jest.Mock;
  delete: jest.Mock;
  createQueryBuilder: jest.Mock;
}

function createInMemoryShortTermRepo(): InMemoryShortTermRepo {
  const records: AgentMemoryShort[] = [];

  const repo: InMemoryShortTermRepo = {
    records,
    find: jest.fn().mockImplementation(async (options?: any) => {
      let filtered = [...records];
      if (options?.where) {
        if (options.where.agentId) {
          filtered = filtered.filter((r) => r.agentId === options.where.agentId);
        }
        if (options.where.tenantId) {
          filtered = filtered.filter((r) => r.tenantId === options.where.tenantId);
        }
      }
      if (options?.order?.createdAt === 'ASC') {
        filtered.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      } else if (options?.order?.createdAt === 'DESC') {
        filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      if (options?.take) {
        filtered = filtered.slice(0, options.take);
      }
      return filtered;
    }),
    findOne: jest.fn().mockImplementation(async (options?: any) => {
      let filtered = [...records];
      if (options?.where) {
        if (options.where.agentId) {
          filtered = filtered.filter((r) => r.agentId === options.where.agentId);
        }
      }
      if (options?.order?.createdAt === 'DESC') {
        filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      return filtered[0] || null;
    }),
    count: jest.fn().mockImplementation(async (options?: any) => {
      let filtered = [...records];
      if (options?.where) {
        if (options.where.agentId) {
          filtered = filtered.filter((r) => r.agentId === options.where.agentId);
        }
        if (options.where.tenantId) {
          filtered = filtered.filter((r) => r.tenantId === options.where.tenantId);
        }
      }
      return filtered.length;
    }),
    create: jest.fn().mockImplementation((dto: Partial<AgentMemoryShort>) => {
      const record: AgentMemoryShort = {
        id: uuidv4(),
        agentId: dto.agentId || '',
        tenantId: dto.tenantId || '',
        role: dto.role || 'user',
        content: dto.content || '',
        metadata: dto.metadata || null,
        createdAt: dto.createdAt || new Date(),
      };
      return record;
    }),
    save: jest.fn().mockImplementation(async (entity: AgentMemoryShort) => {
      records.push(entity);
      return entity;
    }),
    remove: jest.fn().mockImplementation(async (entities: AgentMemoryShort[]) => {
      for (const entity of entities) {
        const idx = records.findIndex((r) => r.id === entity.id);
        if (idx !== -1) records.splice(idx, 1);
      }
      return entities;
    }),
    delete: jest.fn().mockImplementation(async () => ({ affected: 0 })),
    createQueryBuilder: jest.fn(() => ({
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    })),
  };

  return repo;
}

function createInMemoryLongTermRepo(): InMemoryLongTermRepo {
  const records: AgentMemoryLong[] = [];

  const repo: InMemoryLongTermRepo = {
    records,
    find: jest.fn().mockImplementation(async (options?: any) => {
      let filtered = [...records];
      if (options?.where) {
        if (options.where.agentId) {
          filtered = filtered.filter((r) => r.agentId === options.where.agentId);
        }
        if (options.where.tenantId) {
          filtered = filtered.filter((r) => r.tenantId === options.where.tenantId);
        }
      }
      if (options?.order?.createdAt === 'DESC') {
        filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      return filtered;
    }),
    findOne: jest.fn().mockImplementation(async () => null),
    count: jest.fn().mockImplementation(async () => records.length),
    create: jest.fn().mockImplementation((dto: Partial<AgentMemoryLong>) => {
      const record: AgentMemoryLong = {
        id: uuidv4(),
        agentId: dto.agentId || '',
        tenantId: dto.tenantId || '',
        type: dto.type || 'learning',
        summary: dto.summary || '',
        confidence: dto.confidence ?? 0.7,
        sourceInteractions: dto.sourceInteractions || [],
        createdAt: dto.createdAt || new Date(),
      };
      return record;
    }),
    save: jest.fn().mockImplementation(async (entity: AgentMemoryLong) => {
      records.push(entity);
      return entity;
    }),
    remove: jest.fn().mockImplementation(async () => []),
    delete: jest.fn().mockImplementation(async () => ({ affected: 0 })),
    createQueryBuilder: jest.fn(() => ({
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 0 }),
    })),
  };

  return repo;
}

// ----- Arbitraries -----

const roleArb: fc.Arbitrary<InteractionRole> = fc.constantFrom('user', 'assistant', 'system');

const interactionContentArb = fc.string({ minLength: 1, maxLength: 200 });

// Generate an interaction with a specific sequential timestamp
function interactionArb(agentId: string, tenantId: string, seqIndex: number) {
  return fc.record({
    role: roleArb,
    content: interactionContentArb,
  }).map(({ role, content }) => ({
    agentId,
    tenantId,
    role,
    content,
    // Use sequential timestamps to ensure ordering
    timestamp: new Date(2024, 0, 1, 0, 0, seqIndex),
    metadata: undefined as Record<string, any> | undefined,
  }));
}

// Generate between 1 and 10 extra interactions beyond the 50 limit
const extraCountArb = fc.integer({ min: 1, max: 10 });

// ----- Tests -----

describe('Property 11: Promoção de Memória Curto → Longo Prazo', () => {
  let service: AgentMemoryService;
  let shortTermRepo: InMemoryShortTermRepo;
  let longTermRepo: InMemoryLongTermRepo;

  beforeEach(async () => {
    shortTermRepo = createInMemoryShortTermRepo();
    longTermRepo = createInMemoryLongTermRepo();

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

  it('should trigger promotion when adding the 51st interaction (short-term stays ≤ 50)', async () => {
    await fc.assert(
      fc.asyncProperty(
        extraCountArb,
        fc.array(roleArb, { minLength: 51, maxLength: 60 }),
        fc.array(interactionContentArb, { minLength: 51, maxLength: 60 }),
        async (extraCount, roles, contents) => {
          // Reset repos for each run
          shortTermRepo.records.length = 0;
          longTermRepo.records.length = 0;

          const agentId = uuidv4();
          const tenantId = uuidv4();
          const totalInteractions = SHORT_TERM_LIMIT + extraCount;

          // Pre-fill with exactly 50 interactions (within limit)
          for (let i = 0; i < SHORT_TERM_LIMIT; i++) {
            const entity = shortTermRepo.create({
              agentId,
              tenantId,
              role: roles[i % roles.length],
              content: contents[i % contents.length],
              createdAt: new Date(2024, 0, 1, 0, 0, i),
            });
            shortTermRepo.records.push(entity);
          }

          // Now add extra interactions that trigger promotion
          for (let i = 0; i < extraCount; i++) {
            const seqIdx = SHORT_TERM_LIMIT + i;
            await service.persistInteraction(agentId, {
              agentId,
              tenantId,
              role: roles[seqIdx % roles.length],
              content: contents[seqIdx % contents.length],
              timestamp: new Date(2024, 0, 1, 0, 0, seqIdx),
            });
          }

          // PROPERTY: After promotion, short-term count MUST be ≤ 50
          const shortTermCount = shortTermRepo.records.filter(
            (r) => r.agentId === agentId && r.tenantId === tenantId,
          ).length;

          expect(shortTermCount).toBeLessThanOrEqual(SHORT_TERM_LIMIT);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should create long-term entries when promotion triggers', async () => {
    await fc.assert(
      fc.asyncProperty(
        extraCountArb,
        fc.array(interactionContentArb, { minLength: 51, maxLength: 60 }),
        async (extraCount, contents) => {
          // Reset repos for each run
          shortTermRepo.records.length = 0;
          longTermRepo.records.length = 0;

          const agentId = uuidv4();
          const tenantId = uuidv4();

          // Pre-fill with exactly 50 interactions
          for (let i = 0; i < SHORT_TERM_LIMIT; i++) {
            const entity = shortTermRepo.create({
              agentId,
              tenantId,
              role: 'user',
              content: contents[i % contents.length],
              createdAt: new Date(2024, 0, 1, 0, 0, i),
            });
            shortTermRepo.records.push(entity);
          }

          const longTermCountBefore = longTermRepo.records.length;

          // Add interactions to trigger promotion
          for (let i = 0; i < extraCount; i++) {
            const seqIdx = SHORT_TERM_LIMIT + i;
            await service.persistInteraction(agentId, {
              agentId,
              tenantId,
              role: 'user',
              content: contents[seqIdx % contents.length],
              timestamp: new Date(2024, 0, 1, 0, 0, seqIdx),
            });
          }

          // PROPERTY: Promotion creates at least one long-term entry
          const longTermCountAfter = longTermRepo.records.filter(
            (r) => r.agentId === agentId && r.tenantId === tenantId,
          ).length;

          expect(longTermCountAfter).toBeGreaterThan(longTermCountBefore);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('should summarize promoted interactions into the long-term entry with source references', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(interactionContentArb, { minLength: 51, maxLength: 55 }),
        async (contents) => {
          // Reset repos for each run
          shortTermRepo.records.length = 0;
          longTermRepo.records.length = 0;

          const agentId = uuidv4();
          const tenantId = uuidv4();

          // Pre-fill with exactly 50 interactions and track their IDs
          const initialIds: string[] = [];
          for (let i = 0; i < SHORT_TERM_LIMIT; i++) {
            const entity = shortTermRepo.create({
              agentId,
              tenantId,
              role: 'user',
              content: contents[i % contents.length],
              createdAt: new Date(2024, 0, 1, 0, 0, i),
            });
            shortTermRepo.records.push(entity);
            initialIds.push(entity.id);
          }

          // Add 1 extra interaction to trigger promotion
          await service.persistInteraction(agentId, {
            agentId,
            tenantId,
            role: 'assistant',
            content: contents[SHORT_TERM_LIMIT % contents.length],
            timestamp: new Date(2024, 0, 1, 0, 0, SHORT_TERM_LIMIT),
          });

          // PROPERTY: Long-term entries have a non-empty summary and source interaction references
          const longTermEntries = longTermRepo.records.filter(
            (r) => r.agentId === agentId && r.tenantId === tenantId,
          );

          for (const entry of longTermEntries) {
            // Summary must not be empty
            expect(entry.summary).toBeTruthy();
            expect(entry.summary.length).toBeGreaterThan(0);

            // Source interactions must reference existing interaction IDs
            expect(entry.sourceInteractions).toBeDefined();
            expect(entry.sourceInteractions.length).toBeGreaterThan(0);

            // Source interactions should reference IDs from the original set
            for (const srcId of entry.sourceInteractions) {
              expect(initialIds).toContain(srcId);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
