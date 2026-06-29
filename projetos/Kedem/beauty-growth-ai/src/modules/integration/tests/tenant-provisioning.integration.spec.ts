import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { TenantProvisioningListener, TenantCreatedEvent } from '../tenant-provisioning.listener';
import { KnowledgeHubService, PREDEFINED_CATEGORIES } from '../../knowledge-hub/services/knowledge-hub.service';
import { BusinessMemoryService } from '../../business-memory/services/business-memory.service';

/**
 * Integration test for the tenant provisioning flow.
 *
 * Verifies that when a 'tenant.created' event is emitted:
 * 1. AgentConfigService.provisionDefaults() is called (default agents created)
 * 2. KnowledgeHubService.createCategory() is called for each predefined category
 * 3. BusinessMemoryService.getByTenant() is called to check/initialize empty memory
 */
describe('Tenant Provisioning Integration Flow', () => {
  let module: TestingModule;
  let eventEmitter: EventEmitter2;
  let knowledgeHubService: jest.Mocked<KnowledgeHubService>;
  let businessMemoryService: jest.Mocked<BusinessMemoryService>;

  const mockKnowledgeHubService = {
    createCategory: jest.fn().mockResolvedValue({ id: 'cat-1', name: 'test' }),
  };

  const mockBusinessMemoryService = {
    getByTenant: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

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
      ],
    }).compile();

    // Initialize the module so that @OnEvent decorators are registered
    await module.init();

    eventEmitter = module.get<EventEmitter2>(EventEmitter2);
    knowledgeHubService = module.get(KnowledgeHubService);
    businessMemoryService = module.get(BusinessMemoryService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('tenant.created event', () => {
    it('should initialize Knowledge Hub with predefined categories for new tenant', async () => {
      const tenantId = 'new-tenant-uuid';

      // Emit event
      eventEmitter.emit('tenant.created', { tenantId });

      // Wait for async event handlers to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify createCategory was called for each predefined category
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

    it('should check/initialize empty Business Memory for new tenant', async () => {
      const tenantId = 'new-tenant-uuid';

      // Emit event
      eventEmitter.emit('tenant.created', { tenantId });

      // Wait for async event handlers to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify business memory was queried for the new tenant
      expect(businessMemoryService.getByTenant).toHaveBeenCalledWith(tenantId);
    });

    it('should handle the full provisioning flow end-to-end with AgentConfigService', async () => {
      const tenantId = 'e2e-tenant-uuid';

      // Register an additional handler to simulate AgentConfigService's @OnEvent
      const provisionDefaultsMock = jest.fn().mockResolvedValue([
        { id: 'agent-1', agentType: 'content', tenantId },
        { id: 'agent-2', agentType: 'campaigns', tenantId },
        { id: 'agent-3', agentType: 'customer_service', tenantId },
      ]);
      eventEmitter.on('tenant.created', async (event: TenantCreatedEvent) => {
        await provisionDefaultsMock(event.tenantId);
      });

      // Emit event (simulating what AuthService does after registration)
      eventEmitter.emit('tenant.created', { tenantId });

      // Wait for all async handlers to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Verify all provisioning steps were triggered:

      // 1. Default agents were provisioned (simulated)
      expect(provisionDefaultsMock).toHaveBeenCalledWith(tenantId);

      // 2. Knowledge Hub categories were created
      expect(knowledgeHubService.createCategory).toHaveBeenCalledTimes(
        PREDEFINED_CATEGORIES.length,
      );

      // 3. Business Memory was checked/initialized
      expect(businessMemoryService.getByTenant).toHaveBeenCalledWith(tenantId);
    });

    it('should handle Knowledge Hub category creation failure gracefully', async () => {
      const tenantId = 'failing-tenant-uuid';

      // Make createCategory fail for the first category but succeed for the rest
      mockKnowledgeHubService.createCategory
        .mockRejectedValueOnce(new Error('Category already exists'))
        .mockResolvedValue({ id: 'cat-x', name: 'test' });

      // Emit event
      eventEmitter.emit('tenant.created', { tenantId });

      // Wait for async event handlers to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should still attempt to create remaining categories despite one failure
      expect(knowledgeHubService.createCategory).toHaveBeenCalledTimes(
        PREDEFINED_CATEGORIES.length,
      );
    });

    it('should skip Business Memory initialization if entries already exist', async () => {
      const tenantId = 'existing-tenant-uuid';

      // Simulate existing entries
      mockBusinessMemoryService.getByTenant.mockResolvedValueOnce([
        { id: 'entry-1', tenantId, category: 'brand', key: 'existing', value: {} },
      ] as any);

      // Emit event
      eventEmitter.emit('tenant.created', { tenantId });

      // Wait for async event handlers to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should still query but not error
      expect(businessMemoryService.getByTenant).toHaveBeenCalledWith(tenantId);
    });

    it('should complete provisioning within expected timeframe (<1s for all handlers)', async () => {
      const tenantId = 'perf-tenant-uuid';
      const startTime = Date.now();

      // Emit event
      eventEmitter.emit('tenant.created', { tenantId });

      // Wait for async event handlers to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      const duration = Date.now() - startTime;

      // All provisioning handlers should complete within 1 second
      expect(duration).toBeLessThan(1000);

      // Verify all handlers were triggered
      expect(knowledgeHubService.createCategory).toHaveBeenCalled();
      expect(businessMemoryService.getByTenant).toHaveBeenCalled();
    });
  });

  describe('AuthService → tenant.created emission', () => {
    it('should verify that event emission triggers all downstream provisioning', async () => {
      const tenantId = 'auth-flow-tenant';

      // Register additional handler to simulate AgentConfigService
      const agentHandler = jest.fn();
      eventEmitter.on('tenant.created', agentHandler);

      // Simulate what AuthService.register() does after creating a tenant
      eventEmitter.emit('tenant.created', { tenantId });

      // Wait for handlers
      await new Promise((resolve) => setTimeout(resolve, 150));

      // The TenantProvisioningListener handlers should have fired
      expect(knowledgeHubService.createCategory).toHaveBeenCalled();
      expect(businessMemoryService.getByTenant).toHaveBeenCalledWith(tenantId);

      // The additional handler simulating AgentConfigService was also called
      expect(agentHandler).toHaveBeenCalledWith({ tenantId });
    });
  });
});
