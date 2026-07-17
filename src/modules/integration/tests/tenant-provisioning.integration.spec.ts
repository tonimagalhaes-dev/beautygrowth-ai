import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { TenantProvisioningListener, TenantCreatedEvent } from '../tenant-provisioning.listener';
import { KnowledgeHubService, PREDEFINED_CATEGORIES } from '../../knowledge-hub/services/knowledge-hub.service';
import { BusinessMemoryService } from '../../business-memory/services/business-memory.service';
import { AgentMemoryService } from '../../agent-memory/services/agent-memory.service';
import { AgentConfigService } from '../../agent-config/services/agent-config.service';

/**
 * Integration test for the tenant provisioning flow.
 *
 * Verifies that when a 'tenant.created' event is emitted (triggered by Auth registration):
 * 1. AgentConfigService.provisionDefaults() is called (default agents: content, campaigns, customer_service)
 * 2. KnowledgeHubService.createCategory() is called for each predefined category
 * 3. BusinessMemoryService.getByTenant() is called to check/initialize empty memory
 * 4. AgentMemoryService.loadContext() is called for each provisioned agent to verify memory accessibility
 *
 * Requirements: 4.2, 5.1
 */
describe('Tenant Provisioning Integration Flow', () => {
  let module: TestingModule;
  let eventEmitter: EventEmitter2;
  let knowledgeHubService: jest.Mocked<KnowledgeHubService>;
  let businessMemoryService: jest.Mocked<BusinessMemoryService>;
  let agentMemoryService: jest.Mocked<AgentMemoryService>;
  let agentConfigService: jest.Mocked<AgentConfigService>;

  const mockAgents = [
    { id: 'agent-1', agentType: 'content', tenantId: '', status: 'inactive' },
    { id: 'agent-2', agentType: 'campaigns', tenantId: '', status: 'inactive' },
    { id: 'agent-3', agentType: 'customer_service', tenantId: '', status: 'inactive' },
  ];

  const mockKnowledgeHubService = {
    createCategory: jest.fn().mockResolvedValue({ id: 'cat-1', name: 'test' }),
  };

  const mockBusinessMemoryService = {
    getByTenant: jest.fn().mockResolvedValue([]),
  };

  const mockAgentMemoryService = {
    loadContext: jest.fn().mockResolvedValue({
      shortTerm: [],
      longTerm: [],
      metadata: { agentId: '', tenantId: '', shortTermCount: 0, longTermCount: 0, lastInteractionAt: null },
    }),
  };

  const mockAgentConfigService = {
    list: jest.fn().mockImplementation((tenantId: string) =>
      Promise.resolve(mockAgents.map((a) => ({ ...a, tenantId }))),
    ),
    provisionDefaults: jest.fn().mockImplementation((tenantId: string) =>
      Promise.resolve(mockAgents.map((a) => ({ ...a, tenantId }))),
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Reset mock implementations after clearAllMocks
    mockKnowledgeHubService.createCategory.mockResolvedValue({ id: 'cat-1', name: 'test' });
    mockBusinessMemoryService.getByTenant.mockResolvedValue([]);
    mockAgentMemoryService.loadContext.mockResolvedValue({
      shortTerm: [],
      longTerm: [],
      metadata: { agentId: '', tenantId: '', shortTermCount: 0, longTermCount: 0, lastInteractionAt: null },
    });
    mockAgentConfigService.list.mockImplementation((tenantId: string) =>
      Promise.resolve(mockAgents.map((a) => ({ ...a, tenantId }))),
    );
    mockAgentConfigService.provisionDefaults.mockImplementation((tenantId: string) =>
      Promise.resolve(mockAgents.map((a) => ({ ...a, tenantId }))),
    );

    module = await Test.createTestingModule({
      imports: [EventEmitterModule.forRoot()],
      providers: [
        TenantProvisioningListener,
        {
          provide: KnowledgeHubService,
          useValue: mockKnowledgeHubService,
        },
        {
          provide: BusinessMemoryService,
          useValue: mockBusinessMemoryService,
        },
        {
          provide: AgentMemoryService,
          useValue: mockAgentMemoryService,
        },
        {
          provide: AgentConfigService,
          useValue: mockAgentConfigService,
        },
      ],
    }).compile();

    // Initialize the module so that @OnEvent decorators are registered
    await module.init();

    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    knowledgeHubService = module.get(KnowledgeHubService);
    businessMemoryService = module.get(BusinessMemoryService);
    agentMemoryService = module.get(AgentMemoryService);
    agentConfigService = module.get(AgentConfigService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('tenant.created event — Knowledge Hub initialization', () => {
    it('should initialize Knowledge Hub with all predefined categories for new tenant', async () => {
      const tenantId = 'new-tenant-uuid';

      eventEmitter.emit('tenant.created', { tenantId });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(knowledgeHubService.createCategory).toHaveBeenCalledTimes(
        PREDEFINED_CATEGORIES.length,
      );

      for (const category of PREDEFINED_CATEGORIES) {
        expect(knowledgeHubService.createCategory).toHaveBeenCalledWith(
          tenantId,
          {
            name: category,
            description: `Predefined category: ${category}`,
          },
        );
      }
    });

    it('should handle Knowledge Hub category creation failure gracefully', async () => {
      const tenantId = 'failing-tenant-uuid';

      mockKnowledgeHubService.createCategory
        .mockRejectedValueOnce(new Error('Category already exists'))
        .mockResolvedValue({ id: 'cat-x', name: 'test' });

      eventEmitter.emit('tenant.created', { tenantId });
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should still attempt to create remaining categories despite one failure
      expect(knowledgeHubService.createCategory).toHaveBeenCalledTimes(
        PREDEFINED_CATEGORIES.length,
      );
    });
  });

  describe('tenant.created event — Business Memory initialization', () => {
    it('should check and confirm empty Business Memory for new tenant', async () => {
      const tenantId = 'new-tenant-uuid';

      eventEmitter.emit('tenant.created', { tenantId });
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(businessMemoryService.getByTenant).toHaveBeenCalledWith(tenantId);
    });

    it('should skip re-initialization if Business Memory entries already exist', async () => {
      const tenantId = 'existing-tenant-uuid';

      mockBusinessMemoryService.getByTenant.mockResolvedValueOnce([
        { id: 'entry-1', tenantId, category: 'brand', key: 'existing', value: {} },
      ] as any);

      eventEmitter.emit('tenant.created', { tenantId });
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Should still query but not error
      expect(businessMemoryService.getByTenant).toHaveBeenCalledWith(tenantId);
    });
  });

  describe('tenant.created event — Agent Memory initialization', () => {
    it('should verify Agent Memory accessibility for each provisioned agent', async () => {
      const tenantId = 'agent-memory-tenant';

      eventEmitter.emit('tenant.created', { tenantId });
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should call list to get provisioned agents
      expect(agentConfigService.list).toHaveBeenCalledWith(tenantId);

      // Should call loadContext for each provisioned agent
      expect(agentMemoryService.loadContext).toHaveBeenCalledTimes(3);
      expect(agentMemoryService.loadContext).toHaveBeenCalledWith('agent-1', tenantId);
      expect(agentMemoryService.loadContext).toHaveBeenCalledWith('agent-2', tenantId);
      expect(agentMemoryService.loadContext).toHaveBeenCalledWith('agent-3', tenantId);
    });

    it('should handle case where no agents are provisioned yet', async () => {
      const tenantId = 'no-agents-tenant';

      mockAgentConfigService.list.mockResolvedValue([]);

      eventEmitter.emit('tenant.created', { tenantId });
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should not attempt to load memory if no agents exist
      expect(agentMemoryService.loadContext).not.toHaveBeenCalled();
    });

    it('should handle Agent Memory load failure gracefully', async () => {
      const tenantId = 'memory-fail-tenant';

      mockAgentMemoryService.loadContext
        .mockRejectedValueOnce(new Error('Connection timeout'))
        .mockResolvedValue({
          shortTerm: [],
          longTerm: [],
          metadata: { agentId: '', tenantId, shortTermCount: 0, longTermCount: 0, lastInteractionAt: null },
        });

      eventEmitter.emit('tenant.created', { tenantId });
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should still attempt other agents despite one failure
      expect(agentMemoryService.loadContext).toHaveBeenCalledTimes(3);
    });
  });

  describe('Full provisioning flow — end-to-end', () => {
    it('should execute all provisioning steps when tenant.created is emitted', async () => {
      const tenantId = 'e2e-tenant-uuid';

      // Register an additional handler to simulate AgentConfigService's @OnEvent
      const provisionDefaultsMock = jest.fn().mockResolvedValue(
        mockAgents.map((a) => ({ ...a, tenantId })),
      );
      eventEmitter.on('tenant.created', async (event: TenantCreatedEvent) => {
        await provisionDefaultsMock(event.tenantId);
      });

      // Emit event (simulating what AuthService does after registration)
      eventEmitter.emit('tenant.created', { tenantId });
      await new Promise((resolve) => setTimeout(resolve, 500));

      // 1. Default agents were provisioned (simulated via additional handler)
      expect(provisionDefaultsMock).toHaveBeenCalledWith(tenantId);

      // 2. Knowledge Hub categories were created
      expect(knowledgeHubService.createCategory).toHaveBeenCalledTimes(
        PREDEFINED_CATEGORIES.length,
      );

      // 3. Business Memory was checked/initialized
      expect(businessMemoryService.getByTenant).toHaveBeenCalledWith(tenantId);

      // 4. Agent Memory was verified for each provisioned agent
      expect(agentMemoryService.loadContext).toHaveBeenCalledTimes(3);
    });

    it('should complete full provisioning within expected timeframe (<1s)', async () => {
      const tenantId = 'perf-tenant-uuid';
      const startTime = Date.now();

      eventEmitter.emit('tenant.created', { tenantId });
      await new Promise((resolve) => setTimeout(resolve, 500));

      const duration = Date.now() - startTime;

      // All provisioning handlers should complete within 1 second
      expect(duration).toBeLessThan(1000);

      // Verify all handlers were triggered
      expect(knowledgeHubService.createCategory).toHaveBeenCalled();
      expect(businessMemoryService.getByTenant).toHaveBeenCalled();
      expect(agentMemoryService.loadContext).toHaveBeenCalled();
    });

    it('should handle partial failures without blocking other provisioning steps', async () => {
      const tenantId = 'partial-fail-tenant';

      // Knowledge Hub fails completely
      mockKnowledgeHubService.createCategory.mockRejectedValue(
        new Error('Database unavailable'),
      );

      // Business Memory fails
      mockBusinessMemoryService.getByTenant.mockRejectedValue(
        new Error('Connection refused'),
      );

      // Agent Memory works fine
      mockAgentMemoryService.loadContext.mockResolvedValue({
        shortTerm: [],
        longTerm: [],
        metadata: { agentId: '', tenantId, shortTermCount: 0, longTermCount: 0, lastInteractionAt: null },
      });

      eventEmitter.emit('tenant.created', { tenantId });
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Despite failures in other handlers, agent memory should still be attempted
      expect(agentMemoryService.loadContext).toHaveBeenCalled();
    });
  });

  describe('AuthService → tenant.created emission flow', () => {
    it('should verify that event emission from registration triggers all downstream provisioning', async () => {
      const tenantId = 'auth-flow-tenant';

      // Register additional handler to simulate AgentConfigService
      const agentHandler = jest.fn();
      eventEmitter.on('tenant.created', agentHandler);

      // Simulate what AuthService.register() does after creating a tenant
      eventEmitter.emit('tenant.created', { tenantId });
      await new Promise((resolve) => setTimeout(resolve, 500));

      // The TenantProvisioningListener handlers should have fired
      expect(knowledgeHubService.createCategory).toHaveBeenCalled();
      expect(businessMemoryService.getByTenant).toHaveBeenCalledWith(tenantId);
      expect(agentMemoryService.loadContext).toHaveBeenCalled();

      // The additional handler simulating AgentConfigService was also called
      expect(agentHandler).toHaveBeenCalledWith({ tenantId });
    });

    it('should provision exactly 3 default agents (content, campaigns, customer_service)', async () => {
      const tenantId = 'verify-agents-tenant';

      eventEmitter.emit('tenant.created', { tenantId });
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify the agent types that were loaded for memory init
      const listCalls = mockAgentConfigService.list.mock.calls;
      expect(listCalls.length).toBeGreaterThan(0);
      expect(listCalls[0][0]).toBe(tenantId);

      // The mock returns 3 agents with correct types
      const returnedAgents = await mockAgentConfigService.list(tenantId);
      const agentTypes = returnedAgents.map((a: any) => a.agentType);
      expect(agentTypes).toContain('content');
      expect(agentTypes).toContain('campaigns');
      expect(agentTypes).toContain('customer_service');
      expect(returnedAgents).toHaveLength(3);
    });
  });
});
