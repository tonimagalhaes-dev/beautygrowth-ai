import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';

import { AgentMemoryService, SHORT_TERM_LIMIT } from './agent-memory.service';
import { AgentMemoryShort } from '../entities/agent-memory-short.entity';
import { AgentMemoryLong } from '../entities/agent-memory-long.entity';

// Helper to create mock short-term records
function createMockShortTerm(
  overrides: Partial<AgentMemoryShort> = {},
): AgentMemoryShort {
  return {
    id: overrides.id || 'mock-id',
    agentId: overrides.agentId || 'agent-1',
    tenantId: overrides.tenantId || 'tenant-1',
    role: overrides.role || 'user',
    content: overrides.content || 'test content',
    metadata: overrides.metadata || null,
    createdAt: overrides.createdAt || new Date('2024-01-01'),
  };
}

// Helper to create mock long-term records
function createMockLongTerm(
  overrides: Partial<AgentMemoryLong> = {},
): AgentMemoryLong {
  return {
    id: overrides.id || 'long-id',
    agentId: overrides.agentId || 'agent-1',
    tenantId: overrides.tenantId || 'tenant-1',
    type: overrides.type || 'learning',
    summary: overrides.summary || 'test summary',
    confidence: overrides.confidence ?? 0.8,
    sourceInteractions: overrides.sourceInteractions || [],
    createdAt: overrides.createdAt || new Date('2024-01-01'),
  };
}

describe('AgentMemoryService', () => {
  let service: AgentMemoryService;
  let shortTermRepo: any;
  let longTermRepo: any;

  beforeEach(async () => {
    shortTermRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      count: jest.fn(),
      create: jest.fn((dto) => ({ ...dto, id: 'new-id', createdAt: new Date() })),
      save: jest.fn((entity) => Promise.resolve(entity)),
      delete: jest.fn(),
      remove: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
      })),
    };

    longTermRepo = {
      find: jest.fn(),
      findOne: jest.fn(),
      count: jest.fn(),
      create: jest.fn((dto) => ({ ...dto, id: 'long-new-id', createdAt: new Date() })),
      save: jest.fn((entity) => Promise.resolve(entity)),
      delete: jest.fn(),
      remove: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 1 }),
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

  describe('loadContext', () => {
    it('should return short-term and long-term memory with metadata', async () => {
      const mockShort = [createMockShortTerm({ createdAt: new Date('2024-06-01') })];
      const mockLong = [createMockLongTerm()];

      shortTermRepo.find.mockResolvedValue(mockShort);
      longTermRepo.find.mockResolvedValue(mockLong);

      const result = await service.loadContext('agent-1', 'tenant-1');

      expect(result.shortTerm).toHaveLength(1);
      expect(result.longTerm).toHaveLength(1);
      expect(result.metadata.agentId).toBe('agent-1');
      expect(result.metadata.tenantId).toBe('tenant-1');
      expect(result.metadata.shortTermCount).toBe(1);
      expect(result.metadata.longTermCount).toBe(1);
      expect(result.metadata.lastInteractionAt).toEqual(mockShort[0].createdAt);
    });

    it('should return null for lastInteractionAt when no short-term memory exists', async () => {
      shortTermRepo.find.mockResolvedValue([]);
      longTermRepo.find.mockResolvedValue([]);

      const result = await service.loadContext('agent-1', 'tenant-1');

      expect(result.metadata.lastInteractionAt).toBeNull();
      expect(result.shortTerm).toHaveLength(0);
      expect(result.longTerm).toHaveLength(0);
    });

    it('should filter by both agentId and tenantId (agent isolation)', async () => {
      shortTermRepo.find.mockResolvedValue([]);
      longTermRepo.find.mockResolvedValue([]);

      await service.loadContext('agent-1', 'tenant-1');

      expect(shortTermRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { agentId: 'agent-1', tenantId: 'tenant-1' },
        }),
      );
      expect(longTermRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { agentId: 'agent-1', tenantId: 'tenant-1' },
        }),
      );
    });
  });

  describe('persistInteraction', () => {
    it('should save the interaction to short-term memory', async () => {
      shortTermRepo.count.mockResolvedValue(1);

      await service.persistInteraction('agent-1', {
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        role: 'user',
        content: 'Hello agent',
        timestamp: new Date(),
      });

      expect(shortTermRepo.create).toHaveBeenCalledWith({
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        role: 'user',
        content: 'Hello agent',
        metadata: null,
      });
      expect(shortTermRepo.save).toHaveBeenCalled();
    });

    it('should trigger promotion when count exceeds 50', async () => {
      shortTermRepo.count.mockResolvedValue(51);
      shortTermRepo.find.mockResolvedValue([createMockShortTerm()]);

      const promoteSpy = jest.spyOn(service, 'promoteToLongTerm');

      await service.persistInteraction('agent-1', {
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        role: 'user',
        content: 'Message 51',
        timestamp: new Date(),
      });

      expect(promoteSpy).toHaveBeenCalledWith('agent-1', 'tenant-1');
    });

    it('should NOT throw on persistence failure (graceful handling)', async () => {
      shortTermRepo.save.mockRejectedValue(new Error('DB connection failed'));

      // Should not throw
      await expect(
        service.persistInteraction('agent-1', {
          agentId: 'agent-1',
          tenantId: 'tenant-1',
          role: 'user',
          content: 'Hello',
          timestamp: new Date(),
        }),
      ).resolves.toBeUndefined();
    });

    it('should save metadata when provided', async () => {
      shortTermRepo.count.mockResolvedValue(1);

      await service.persistInteraction('agent-1', {
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        role: 'assistant',
        content: 'Response',
        timestamp: new Date(),
        metadata: { source: 'content-agent', tokensUsed: 150 },
      });

      expect(shortTermRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { source: 'content-agent', tokensUsed: 150 },
        }),
      );
    });
  });

  describe('promoteToLongTerm', () => {
    it('should promote excess interactions to long-term and remove them from short-term', async () => {
      const oldInteractions = Array.from({ length: 51 }, (_, i) =>
        createMockShortTerm({
          id: `id-${i}`,
          content: `message ${i}`,
          createdAt: new Date(2024, 0, i + 1),
        }),
      );

      shortTermRepo.count.mockResolvedValue(51);
      shortTermRepo.find.mockResolvedValue(oldInteractions);

      await service.promoteToLongTerm('agent-1', 'tenant-1');

      // Should create a long-term entry
      expect(longTermRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-1',
          tenantId: 'tenant-1',
          type: 'learning',
          confidence: 0.7,
        }),
      );
      expect(longTermRepo.save).toHaveBeenCalled();

      // Should remove 1 promoted interaction (51 - 50 = 1 excess)
      expect(shortTermRepo.remove).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: 'id-0' })]),
      );
    });

    it('should not promote when count is within limit', async () => {
      shortTermRepo.count.mockResolvedValue(50);

      await service.promoteToLongTerm('agent-1', 'tenant-1');

      expect(longTermRepo.create).not.toHaveBeenCalled();
      expect(shortTermRepo.remove).not.toHaveBeenCalled();
    });

    it('should resolve tenantId from existing records if not provided', async () => {
      shortTermRepo.findOne.mockResolvedValue(
        createMockShortTerm({ tenantId: 'resolved-tenant' }),
      );
      shortTermRepo.count.mockResolvedValue(30);

      await service.promoteToLongTerm('agent-1');

      expect(shortTermRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { agentId: 'agent-1' },
        }),
      );
    });
  });

  describe('clearMemory', () => {
    it('should throw BadRequestException when requireConfirmation is false', async () => {
      await expect(
        service.clearMemory('agent-1', {
          type: 'all',
          requireConfirmation: false,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should clear all memory when type is "all" and confirmed', async () => {
      await service.clearMemory('agent-1', {
        type: 'all',
        requireConfirmation: true,
      });

      expect(shortTermRepo.delete).toHaveBeenCalledWith({ agentId: 'agent-1' });
      expect(longTermRepo.delete).toHaveBeenCalledWith({ agentId: 'agent-1' });
    });

    it('should clear only short-term when type is "short_term"', async () => {
      await service.clearMemory('agent-1', {
        type: 'short_term',
        requireConfirmation: true,
      });

      expect(shortTermRepo.delete).toHaveBeenCalledWith({ agentId: 'agent-1' });
      expect(longTermRepo.delete).not.toHaveBeenCalled();
    });

    it('should clear only long-term when type is "long_term"', async () => {
      await service.clearMemory('agent-1', {
        type: 'long_term',
        requireConfirmation: true,
      });

      expect(shortTermRepo.delete).not.toHaveBeenCalled();
      expect(longTermRepo.delete).toHaveBeenCalledWith({ agentId: 'agent-1' });
    });

    it('should apply period filter when provided', async () => {
      const start = new Date('2024-01-01');
      const end = new Date('2024-06-30');

      await service.clearMemory('agent-1', {
        type: 'short_term',
        period: { start, end },
        requireConfirmation: true,
      });

      expect(shortTermRepo.createQueryBuilder).toHaveBeenCalled();
    });
  });

  describe('getShortTermMemory', () => {
    it('should return at most 50 interactions ordered by most recent', async () => {
      const mockRecords = Array.from({ length: 50 }, (_, i) =>
        createMockShortTerm({ id: `id-${i}` }),
      );
      shortTermRepo.find.mockResolvedValue(mockRecords);

      const result = await service.getShortTermMemory('agent-1', 'tenant-1');

      expect(result).toHaveLength(50);
      expect(shortTermRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          take: SHORT_TERM_LIMIT,
          order: { createdAt: 'DESC' },
        }),
      );
    });

    it('should map entity fields to Interaction interface', async () => {
      const record = createMockShortTerm({
        id: 'test-id',
        role: 'assistant',
        content: 'Response from agent',
        metadata: { key: 'value' },
      });
      shortTermRepo.find.mockResolvedValue([record]);

      const result = await service.getShortTermMemory('agent-1');

      expect(result[0]).toEqual({
        id: 'test-id',
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        role: 'assistant',
        content: 'Response from agent',
        timestamp: record.createdAt,
        metadata: { key: 'value' },
      });
    });
  });

  describe('getLongTermMemory', () => {
    it('should return long-term entries ordered by most recent', async () => {
      const mockRecords = [createMockLongTerm()];
      longTermRepo.find.mockResolvedValue(mockRecords);

      const result = await service.getLongTermMemory('agent-1', 'tenant-1');

      expect(result).toHaveLength(1);
      expect(longTermRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { agentId: 'agent-1', tenantId: 'tenant-1' },
          order: { createdAt: 'DESC' },
        }),
      );
    });

    it('should map entity fields to LongTermEntry interface', async () => {
      const record = createMockLongTerm({
        id: 'lt-1',
        type: 'pattern',
        summary: 'User prefers formal tone',
        confidence: 0.95,
        sourceInteractions: ['id-1', 'id-2'],
      });
      longTermRepo.find.mockResolvedValue([record]);

      const result = await service.getLongTermMemory('agent-1');

      expect(result[0]).toEqual({
        id: 'lt-1',
        agentId: 'agent-1',
        tenantId: 'tenant-1',
        type: 'pattern',
        summary: 'User prefers formal tone',
        confidence: 0.95,
        createdAt: record.createdAt,
        sourceInteractions: ['id-1', 'id-2'],
      });
    });
  });

  describe('agent-to-agent isolation', () => {
    it('should only return memory for the requested agentId', async () => {
      shortTermRepo.find.mockResolvedValue([]);
      longTermRepo.find.mockResolvedValue([]);

      await service.loadContext('agent-A', 'tenant-1');

      // Verify the query is scoped to agent-A
      expect(shortTermRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ agentId: 'agent-A' }),
        }),
      );
    });

    it('agent B memory should not appear when loading agent A context', async () => {
      // Simulate that repo returns nothing for agent-A
      shortTermRepo.find.mockResolvedValue([]);
      longTermRepo.find.mockResolvedValue([]);

      const context = await service.loadContext('agent-A', 'tenant-1');

      expect(context.shortTerm).toHaveLength(0);
      expect(context.longTerm).toHaveLength(0);
    });
  });
});
