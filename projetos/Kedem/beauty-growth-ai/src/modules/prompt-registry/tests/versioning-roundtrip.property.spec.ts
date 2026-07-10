import * as fc from 'fast-check';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { PromptRegistryService } from '../services/prompt-registry.service';
import { Prompt, AgentType, PromptFunction } from '../entities/prompt.entity';
import { PromptVersion } from '../entities/prompt-version.entity';
import { CACHE_SERVICE } from '../../cache/config/cache.constants';
import { CacheKeyBuilder } from '../../cache/services/cache-key-builder.service';

/**
 * Property 19: Prompt Versioning Round-Trip
 *
 * For any sequence of edits to a prompt, each edit creates a new version in the history.
 * A rollback to any version X MUST result in that version X being the active one,
 * AND the active prompt content must be identical to version X's content.
 *
 * **Validates: Requirements 10.2, 10.4**
 */
describe('Property 19: Prompt Versioning Round-Trip', () => {
  let service: PromptRegistryService;

  // In-memory stores to simulate repositories
  let promptStore: Map<string, Prompt>;
  let versionStore: Map<string, PromptVersion>;
  let idCounter: number;

  beforeEach(async () => {
    promptStore = new Map();
    versionStore = new Map();
    idCounter = 0;

    const generateId = () => {
      idCounter++;
      return `00000000-0000-0000-0000-${String(idCounter).padStart(12, '0')}`;
    };

    const mockPromptRepository = {
      create: (dto: Partial<Prompt>) => {
        const id = generateId();
        return { ...dto, id, createdAt: new Date(), versions: [] } as Prompt;
      },
      save: async (entity: Prompt) => {
        promptStore.set(entity.id, { ...entity });
        return entity;
      },
      findOne: async ({ where }: { where: { id: string } }) => {
        return promptStore.get(where.id) || null;
      },
    };

    const mockVersionRepository = {
      create: (dto: Partial<PromptVersion>) => {
        const id = generateId();
        return { ...dto, id, createdAt: new Date() } as PromptVersion;
      },
      save: async (entity: PromptVersion) => {
        versionStore.set(entity.id, { ...entity });
        return entity;
      },
      findOne: async ({ where }: { where: Record<string, any> }) => {
        for (const v of versionStore.values()) {
          let match = true;
          for (const [key, val] of Object.entries(where)) {
            if ((v as any)[key] !== val) {
              match = false;
              break;
            }
          }
          if (match) return v;
        }
        return null;
      },
      find: async ({ where, order }: { where: Record<string, any>; order?: any }) => {
        const results: PromptVersion[] = [];
        for (const v of versionStore.values()) {
          let match = true;
          for (const [key, val] of Object.entries(where)) {
            if ((v as any)[key] !== val) {
              match = false;
              break;
            }
          }
          if (match) results.push(v);
        }
        if (order?.createdAt === 'DESC') {
          results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return results;
      },
      update: async (criteria: Record<string, any>, updateDto: Record<string, any>) => {
        let affected = 0;
        for (const v of versionStore.values()) {
          let match = true;
          for (const [key, val] of Object.entries(criteria)) {
            if ((v as any)[key] !== val) {
              match = false;
              break;
            }
          }
          if (match) {
            for (const [key, val] of Object.entries(updateDto)) {
              (v as any)[key] = val;
            }
            affected++;
          }
        }
        return { affected };
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PromptRegistryService,
        {
          provide: getRepositoryToken(Prompt),
          useValue: mockPromptRepository,
        },
        {
          provide: getRepositoryToken(PromptVersion),
          useValue: mockVersionRepository,
        },
        {
          provide: CACHE_SERVICE,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CacheKeyBuilder,
          useValue: new CacheKeyBuilder(),
        },
      ],
    }).compile();

    service = module.get<PromptRegistryService>(PromptRegistryService);
  });

  // Arbitraries
  const agentTypeArb = fc.constantFrom<AgentType>('content', 'campaigns', 'customer_service');
  const promptFunctionArb = fc.constantFrom<PromptFunction>('system', 'task', 'formatting');

  // Generate non-empty prompt content (may include template variables)
  const contentArb = fc.oneof(
    fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
    fc.tuple(
      fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
      fc.stringMatching(/^[a-z][a-z_]{0,15}$/),
      fc.string({ minLength: 0, maxLength: 50 }),
    ).map(([prefix, varName, suffix]) => `${prefix} {{${varName}}} ${suffix}`),
  );

  // Generate a sequence of N update contents (1 to 8 updates)
  const updatesArb = fc.array(contentArb, { minLength: 1, maxLength: 8 });

  /**
   * Helper: generates semver version strings in increasing order.
   * Starting from 1.0.0, increments patch for each update.
   */
  function generateVersionSequence(count: number): string[] {
    const versions: string[] = [];
    for (let i = 0; i <= count; i++) {
      versions.push(`1.${i}.0`);
    }
    return versions;
  }

  it(
    'after rollback to version X, getActive returns content identical to version X',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          agentTypeArb,
          promptFunctionArb,
          contentArb,
          updatesArb,
          async (agentType, promptFunction, initialContent, updateContents) => {
            // Reset stores for each iteration
            promptStore.clear();
            versionStore.clear();
            idCounter = 0;

            const totalVersions = 1 + updateContents.length; // initial + updates
            const versions = generateVersionSequence(updateContents.length);

            // 1. Create a prompt with initial version
            const prompt = await service.create(
              {
                agentType,
                function: promptFunction,
                content: initialContent,
                version: versions[0],
                description: 'Initial version',
              },
              null,
            );

            // Track all version contents for verification
            const versionContentMap: Record<string, string> = {};
            versionContentMap[versions[0]] = initialContent;

            // 2. Generate N updates (each creating a new version with different content)
            for (let i = 0; i < updateContents.length; i++) {
              await service.update(
                prompt.id,
                {
                  content: updateContents[i],
                  version: versions[i + 1],
                  description: `Update ${i + 1}`,
                },
                null,
              );
              versionContentMap[versions[i + 1]] = updateContents[i];
            }

            // 3. Pick a random previous version to rollback to (any version in the range)
            const rollbackIndex = Math.floor(Math.random() * totalVersions);
            const rollbackVersion = versions[rollbackIndex];
            const expectedContent = versionContentMap[rollbackVersion];

            // 4. Rollback to the selected version
            await service.rollback(prompt.id, rollbackVersion);

            // 5. Verify getActive returns content identical to the selected version
            const active = await service.getActive(prompt.id);
            expect(active.version).toBe(rollbackVersion);
            expect(active.content).toBe(expectedContent);
          },
        ),
        { numRuns: 150 },
      );
    },
  );

  it(
    'rollback is idempotent — rolling back to the same version twice yields same result',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          agentTypeArb,
          contentArb,
          updatesArb,
          async (agentType, initialContent, updateContents) => {
            promptStore.clear();
            versionStore.clear();
            idCounter = 0;

            const versions = generateVersionSequence(updateContents.length);

            const prompt = await service.create(
              {
                agentType,
                function: 'system',
                content: initialContent,
                version: versions[0],
              },
              null,
            );

            for (let i = 0; i < updateContents.length; i++) {
              await service.update(
                prompt.id,
                { content: updateContents[i], version: versions[i + 1] },
                null,
              );
            }

            // Pick any version
            const rollbackIndex = Math.floor(Math.random() * versions.length);
            const targetVersion = versions[rollbackIndex];

            // Rollback twice
            await service.rollback(prompt.id, targetVersion);
            const firstActive = await service.getActive(prompt.id);

            await service.rollback(prompt.id, targetVersion);
            const secondActive = await service.getActive(prompt.id);

            // Both should yield identical results
            expect(firstActive.version).toBe(secondActive.version);
            expect(firstActive.content).toBe(secondActive.content);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    'sequential rollbacks to different versions always yield correct content',
    async () => {
      await fc.assert(
        fc.asyncProperty(
          agentTypeArb,
          contentArb,
          updatesArb,
          fc.array(fc.nat(), { minLength: 2, maxLength: 5 }),
          async (agentType, initialContent, updateContents, rollbackSeeds) => {
            promptStore.clear();
            versionStore.clear();
            idCounter = 0;

            const versions = generateVersionSequence(updateContents.length);
            const versionContentMap: Record<string, string> = {};
            versionContentMap[versions[0]] = initialContent;

            const prompt = await service.create(
              {
                agentType,
                function: 'task',
                content: initialContent,
                version: versions[0],
              },
              null,
            );

            for (let i = 0; i < updateContents.length; i++) {
              await service.update(
                prompt.id,
                { content: updateContents[i], version: versions[i + 1] },
                null,
              );
              versionContentMap[versions[i + 1]] = updateContents[i];
            }

            // Perform multiple rollbacks in sequence, verifying each one
            for (const seed of rollbackSeeds) {
              const rollbackIndex = seed % versions.length;
              const targetVersion = versions[rollbackIndex];
              const expectedContent = versionContentMap[targetVersion];

              await service.rollback(prompt.id, targetVersion);
              const active = await service.getActive(prompt.id);

              expect(active.version).toBe(targetVersion);
              expect(active.content).toBe(expectedContent);
            }
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
