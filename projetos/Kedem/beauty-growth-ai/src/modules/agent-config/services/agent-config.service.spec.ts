import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { AgentConfigService, AGENT_DEFAULTS } from './agent-config.service';
import { AgentConfig } from '../entities/agent-config.entity';
import { ConfigChange } from '../entities/config-change.entity';
import { UpdateAgentConfigDto } from '../dto/update-agent-config.dto';

describe('AgentConfigService', () => {
  let service: AgentConfigService;
  let agentConfigRepo: Record<string, jest.Mock>;
  let configChangeRepo: Record<string, jest.Mock>;

  const mockTenantId = '11111111-1111-1111-1111-111111111111';
  const mockUserId = '22222222-2222-2222-2222-222222222222';
  const mockAgentId = '33333333-3333-3333-3333-333333333333';

  const mockAgent: AgentConfig = {
    id: mockAgentId,
    tenantId: mockTenantId,
    agentType: 'content',
    status: 'inactive',
    modelId: null,
    temperature: 0.7,
    maxTokens: 2048,
    systemPromptId: null,
    knowledgeCategories: [],
    fallbackModelId: null,
    lastExecutedAt: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  const mockManager = {
    query: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentConfigService,
        {
          provide: getRepositoryToken(AgentConfig),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            manager: mockManager,
          },
        },
        {
          provide: getRepositoryToken(ConfigChange),
          useValue: {
            find: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AgentConfigService>(AgentConfigService);
    agentConfigRepo = module.get(getRepositoryToken(AgentConfig));
    configChangeRepo = module.get(getRepositoryToken(ConfigChange));
  });

  describe('provisionDefaults', () => {
    it('should create 3 default agents for a new tenant', async () => {
      agentConfigRepo.find.mockResolvedValue([]);
      agentConfigRepo.create.mockImplementation((data: any) => ({ ...mockAgent, ...data }));
      agentConfigRepo.save.mockImplementation(async (agents: any) => agents);

      const result = await service.provisionDefaults(mockTenantId);

      expect(agentConfigRepo.create).toHaveBeenCalledTimes(3);
      expect(result).toHaveLength(3);

      const types = agentConfigRepo.create.mock.calls.map(
        (call: any[]) => call[0].agentType,
      );
      expect(types).toContain('content');
      expect(types).toContain('campaigns');
      expect(types).toContain('customer_service');
    });

    it('should not duplicate agents that already exist', async () => {
      const existingAgent = { ...mockAgent, agentType: 'content' as const };
      agentConfigRepo.find.mockResolvedValue([existingAgent]);
      agentConfigRepo.create.mockImplementation((data: any) => ({ ...mockAgent, ...data }));
      agentConfigRepo.save.mockImplementation(async (agents: any) => agents);

      const result = await service.provisionDefaults(mockTenantId);

      // Should only create 2 new agents (campaigns + customer_service)
      expect(agentConfigRepo.create).toHaveBeenCalledTimes(2);
      // Result includes existing + new
      expect(result).toHaveLength(3);
    });

    it('should return existing agents when all 3 already exist', async () => {
      const existingAgents = [
        { ...mockAgent, agentType: 'content' as const },
        { ...mockAgent, agentType: 'campaigns' as const },
        { ...mockAgent, agentType: 'customer_service' as const },
      ];
      agentConfigRepo.find.mockResolvedValue(existingAgents);

      const result = await service.provisionDefaults(mockTenantId);

      expect(agentConfigRepo.create).not.toHaveBeenCalled();
      expect(result).toEqual(existingAgents);
    });

    it('should set default temperature to 0.7 and maxTokens to 2048', async () => {
      agentConfigRepo.find.mockResolvedValue([]);
      agentConfigRepo.create.mockImplementation((data: any) => ({ ...mockAgent, ...data }));
      agentConfigRepo.save.mockImplementation(async (agents: any) => agents);

      await service.provisionDefaults(mockTenantId);

      for (const call of agentConfigRepo.create.mock.calls) {
        expect(call[0].temperature).toBe(0.7);
        expect(call[0].maxTokens).toBe(2048);
      }
    });
  });

  describe('list', () => {
    it('should return all agents for a tenant', async () => {
      const agents = [mockAgent];
      agentConfigRepo.find.mockResolvedValue(agents);

      const result = await service.list(mockTenantId);

      expect(agentConfigRepo.find).toHaveBeenCalledWith({
        where: { tenantId: mockTenantId },
        order: { agentType: 'ASC' },
      });
      expect(result).toEqual(agents);
    });
  });

  describe('activate', () => {
    it('should set agent status to active', async () => {
      agentConfigRepo.findOne.mockResolvedValue({ ...mockAgent });
      agentConfigRepo.save.mockImplementation(async (agent: any) => agent);

      await service.activate(mockAgentId);

      expect(agentConfigRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'active' }),
      );
    });

    it('should throw NotFoundException for non-existent agent', async () => {
      agentConfigRepo.findOne.mockResolvedValue(null);

      await expect(service.activate('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deactivate', () => {
    it('should set agent status to inactive', async () => {
      agentConfigRepo.findOne.mockResolvedValue({ ...mockAgent, status: 'active' as const });
      agentConfigRepo.save.mockImplementation(async (agent: any) => agent);

      await service.deactivate(mockAgentId);

      expect(agentConfigRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'inactive' }),
      );
    });

    it('should throw NotFoundException for non-existent agent', async () => {
      agentConfigRepo.findOne.mockResolvedValue(null);

      await expect(service.deactivate('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update temperature and record change history', async () => {
      const agent = { ...mockAgent, temperature: 0.7 };
      agentConfigRepo.findOne.mockResolvedValue(agent);
      agentConfigRepo.save.mockImplementation(async (a: any) => a);
      configChangeRepo.create.mockImplementation((data: any) => data);
      configChangeRepo.save.mockImplementation(async (records: any) => records);

      const dto: UpdateAgentConfigDto = { temperature: 1.2 };
      await service.update(mockAgentId, dto, mockUserId);

      expect(agentConfigRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 1.2 }),
      );
      expect(configChangeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          field: 'temperature',
          previousValue: 0.7,
          newValue: 1.2,
        }),
      );
    });

    it('should reject temperature below 0.0', async () => {
      agentConfigRepo.findOne.mockResolvedValue({ ...mockAgent });

      const dto: UpdateAgentConfigDto = { temperature: -0.1 };

      await expect(service.update(mockAgentId, dto, mockUserId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should reject temperature above 2.0', async () => {
      agentConfigRepo.findOne.mockResolvedValue({ ...mockAgent });

      const dto: UpdateAgentConfigDto = { temperature: 2.1 };

      await expect(service.update(mockAgentId, dto, mockUserId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should accept temperature at boundaries (0.0 and 2.0)', async () => {
      agentConfigRepo.findOne.mockResolvedValue({ ...mockAgent });
      agentConfigRepo.save.mockImplementation(async (a: any) => a);
      configChangeRepo.create.mockImplementation((data: any) => data);
      configChangeRepo.save.mockImplementation(async (records: any) => records);

      await service.update(mockAgentId, { temperature: 0.0 }, mockUserId);
      expect(agentConfigRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 0.0 }),
      );

      agentConfigRepo.findOne.mockResolvedValue({ ...mockAgent });
      await service.update(mockAgentId, { temperature: 2.0 }, mockUserId);
      expect(agentConfigRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ temperature: 2.0 }),
      );
    });

    it('should validate maxTokens against model limit', async () => {
      const modelId = '44444444-4444-4444-4444-444444444444';
      const agent = { ...mockAgent, modelId };
      agentConfigRepo.findOne.mockResolvedValue(agent);
      mockManager.query.mockResolvedValue([{ max_output_tokens: 4096 }]);

      const dto: UpdateAgentConfigDto = { maxTokens: 5000 };

      await expect(service.update(mockAgentId, dto, mockUserId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should accept maxTokens within model limit', async () => {
      const modelId = '44444444-4444-4444-4444-444444444444';
      const agent = { ...mockAgent, modelId };
      agentConfigRepo.findOne.mockResolvedValue(agent);
      agentConfigRepo.save.mockImplementation(async (a: any) => a);
      mockManager.query.mockResolvedValue([{ max_output_tokens: 4096 }]);
      configChangeRepo.create.mockImplementation((data: any) => data);
      configChangeRepo.save.mockImplementation(async (records: any) => records);

      const dto: UpdateAgentConfigDto = { maxTokens: 4096 };
      await service.update(mockAgentId, dto, mockUserId);

      expect(agentConfigRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ maxTokens: 4096 }),
      );
    });

    it('should not record changes if values are unchanged', async () => {
      const agent = { ...mockAgent, temperature: 0.7 };
      agentConfigRepo.findOne.mockResolvedValue(agent);
      agentConfigRepo.save.mockImplementation(async (a: any) => a);
      configChangeRepo.save.mockImplementation(async (records: any) => records);

      const dto: UpdateAgentConfigDto = { temperature: 0.7 };
      await service.update(mockAgentId, dto, mockUserId);

      expect(configChangeRepo.create).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException for non-existent agent', async () => {
      agentConfigRepo.findOne.mockResolvedValue(null);

      await expect(
        service.update('nonexistent', { temperature: 1.0 }, mockUserId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('resetToDefaults', () => {
    it('should restore temperature, maxTokens, and knowledgeCategories to defaults', async () => {
      const modifiedAgent = {
        ...mockAgent,
        temperature: 1.5,
        maxTokens: 8000,
        knowledgeCategories: ['marketing', 'procedures'],
      };
      agentConfigRepo.findOne.mockResolvedValue(modifiedAgent);
      agentConfigRepo.save.mockImplementation(async (a: any) => a);

      const result = await service.resetToDefaults(mockAgentId);

      expect(result.temperature).toBe(AGENT_DEFAULTS.temperature);
      expect(result.maxTokens).toBe(AGENT_DEFAULTS.maxTokens);
      expect(result.knowledgeCategories).toEqual(AGENT_DEFAULTS.knowledgeCategories);
    });

    it('should NOT alter agentType, modelId, or other identity fields', async () => {
      const modifiedAgent = {
        ...mockAgent,
        modelId: '55555555-5555-5555-5555-555555555555',
        systemPromptId: '66666666-6666-6666-6666-666666666666',
        temperature: 1.8,
        maxTokens: 10000,
      };
      agentConfigRepo.findOne.mockResolvedValue(modifiedAgent);
      agentConfigRepo.save.mockImplementation(async (a: any) => a);

      const result = await service.resetToDefaults(mockAgentId);

      // These should remain unchanged — reset only affects temperature/maxTokens/knowledgeCategories
      expect(result.modelId).toBe('55555555-5555-5555-5555-555555555555');
      expect(result.systemPromptId).toBe('66666666-6666-6666-6666-666666666666');
      expect(result.agentType).toBe('content');
    });

    it('should throw NotFoundException for non-existent agent', async () => {
      agentConfigRepo.findOne.mockResolvedValue(null);

      await expect(service.resetToDefaults('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getConfigHistory', () => {
    it('should return config changes ordered by most recent', async () => {
      const changes: ConfigChange[] = [
        {
          id: 'c1',
          agentId: mockAgentId,
          tenantId: mockTenantId,
          userId: mockUserId,
          field: 'temperature',
          previousValue: 0.7,
          newValue: 1.0,
          changedAt: new Date('2024-01-02'),
        },
        {
          id: 'c2',
          agentId: mockAgentId,
          tenantId: mockTenantId,
          userId: mockUserId,
          field: 'maxTokens',
          previousValue: 2048,
          newValue: 4096,
          changedAt: new Date('2024-01-01'),
        },
      ];
      configChangeRepo.find.mockResolvedValue(changes);

      const result = await service.getConfigHistory(mockAgentId);

      expect(configChangeRepo.find).toHaveBeenCalledWith({
        where: { agentId: mockAgentId },
        order: { changedAt: 'DESC' },
      });
      expect(result).toEqual(changes);
    });
  });

  describe('handleTenantCreated', () => {
    it('should provision default agents on tenant.created event', async () => {
      agentConfigRepo.find.mockResolvedValue([]);
      agentConfigRepo.create.mockImplementation((data: any) => ({ ...mockAgent, ...data }));
      agentConfigRepo.save.mockImplementation(async (agents: any) => agents);

      await service.handleTenantCreated({ tenantId: mockTenantId });

      expect(agentConfigRepo.create).toHaveBeenCalledTimes(3);
    });
  });
});
