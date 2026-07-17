import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { KnowledgeHubService } from '../knowledge-hub/services/knowledge-hub.service';
import { PREDEFINED_CATEGORIES } from '../knowledge-hub/services/knowledge-hub.service';
import { BusinessMemoryService } from '../business-memory/services/business-memory.service';
import { AgentMemoryService } from '../agent-memory/services/agent-memory.service';
import { AgentConfigService } from '../agent-config/services/agent-config.service';

/**
 * Event payload emitted when a new tenant is created (after user registration).
 */
export interface TenantCreatedEvent {
  tenantId: string;
}

/**
 * Result of the full provisioning flow for a new tenant.
 */
export interface ProvisioningResult {
  tenantId: string;
  knowledgeHubInitialized: boolean;
  businessMemoryInitialized: boolean;
  agentMemoryInitialized: boolean;
  agentsProvisioned: number;
  errors: string[];
  durationMs: number;
}

/**
 * Tenant Provisioning Listener
 *
 * Listens for 'tenant.created' events and orchestrates downstream provisioning:
 * 1. AgentConfigService handles its own provisioning via @OnEvent('tenant.created')
 * 2. This listener initializes the Knowledge Hub (predefined categories)
 * 3. This listener initializes Business Memory (empty state confirmation)
 * 4. This listener initializes Agent Memory (confirms empty memory space exists for each agent)
 *
 * The AgentConfigService already has its own @OnEvent handler, so we don't need
 * to call provisionDefaults here — it's already wired.
 *
 * Requirements: 4.2, 5.1
 */
@Injectable()
export class TenantProvisioningListener {
  private readonly logger = new Logger(TenantProvisioningListener.name);

  constructor(
    private readonly knowledgeHubService: KnowledgeHubService,
    private readonly businessMemoryService: BusinessMemoryService,
    private readonly agentMemoryService: AgentMemoryService,
    private readonly agentConfigService: AgentConfigService,
  ) {}

  /**
   * Handles 'tenant.created' event to initialize the Knowledge Hub
   * with predefined categories for the new tenant.
   */
  @OnEvent('tenant.created', { async: true })
  async handleKnowledgeHubInit(event: TenantCreatedEvent): Promise<void> {
    this.logger.log(
      `Initializing Knowledge Hub for tenant ${event.tenantId}`,
    );

    try {
      for (const categoryName of PREDEFINED_CATEGORIES) {
        try {
          await this.knowledgeHubService.createCategory(event.tenantId, {
            name: categoryName,
            description: `Predefined category: ${categoryName}`,
          });
        } catch (error: any) {
          // Category might already exist — that's fine
          this.logger.warn(
            `Could not create category '${categoryName}' for tenant ${event.tenantId}: ${error?.message}`,
          );
        }
      }
      this.logger.log(
        `Knowledge Hub initialized for tenant ${event.tenantId}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to initialize Knowledge Hub for tenant ${event.tenantId}`,
        error?.stack,
      );
    }
  }

  /**
   * Handles 'tenant.created' event to initialize the Business Memory
   * with empty state for the new tenant.
   */
  @OnEvent('tenant.created', { async: true })
  async handleBusinessMemoryInit(event: TenantCreatedEvent): Promise<void> {
    this.logger.log(
      `Initializing Business Memory for tenant ${event.tenantId}`,
    );

    try {
      // Check if business memory already has entries for this tenant
      const existingEntries = await this.businessMemoryService.getByTenant(
        event.tenantId,
      );

      if (existingEntries.length === 0) {
        // The business memory is accessible and empty — this is the expected initial state.
        // Real data will be populated once the clinic/brand is configured.
        this.logger.log(
          `Business Memory initialized (empty) for tenant ${event.tenantId}`,
        );
      } else {
        this.logger.log(
          `Business Memory already has ${existingEntries.length} entries for tenant ${event.tenantId}`,
        );
      }
    } catch (error: any) {
      this.logger.error(
        `Failed to initialize Business Memory for tenant ${event.tenantId}`,
        error?.stack,
      );
    }
  }

  /**
   * Handles 'tenant.created' event to initialize Agent Memory for the new tenant.
   * Verifies that Agent Memory is accessible for provisioned agents.
   *
   * This handler runs after agent provisioning completes (the AgentConfigService
   * handler fires first since it's synchronous). It loads context for each
   * provisioned agent to confirm their memory space is accessible.
   *
   * Requirements: 4.2 ("registro de Memória_do_Agente próprio")
   */
  @OnEvent('tenant.created', { async: true })
  async handleAgentMemoryInit(event: TenantCreatedEvent): Promise<void> {
    this.logger.log(
      `Initializing Agent Memory for tenant ${event.tenantId}`,
    );

    try {
      // Wait briefly for agent provisioning to complete (it runs synchronously
      // in AgentConfigService's @OnEvent handler)
      await this.waitForAgentProvisioning(event.tenantId);

      // Get the provisioned agents for this tenant
      const agents = await this.agentConfigService.list(event.tenantId);

      if (agents.length === 0) {
        this.logger.warn(
          `No agents found for tenant ${event.tenantId} during memory init — agents may not have been provisioned yet`,
        );
        return;
      }

      // Verify agent memory is accessible for each agent by loading their context
      for (const agent of agents) {
        try {
          const context = await this.agentMemoryService.loadContext(
            agent.id,
            event.tenantId,
          );
          this.logger.debug(
            `Agent Memory accessible for agent ${agent.id} (${agent.agentType}): ` +
            `shortTerm=${context.metadata.shortTermCount}, longTerm=${context.metadata.longTermCount}`,
          );
        } catch (error: any) {
          this.logger.warn(
            `Could not verify Agent Memory for agent ${agent.id}: ${error?.message}`,
          );
        }
      }

      this.logger.log(
        `Agent Memory initialized for ${agents.length} agents in tenant ${event.tenantId}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to initialize Agent Memory for tenant ${event.tenantId}`,
        error?.stack,
      );
    }
  }

  /**
   * Wait briefly for agent provisioning to complete.
   * The AgentConfigService's @OnEvent('tenant.created') is synchronous,
   * so it should complete before this async handler fully processes.
   * We add a small delay to be safe in case of event loop timing.
   */
  private async waitForAgentProvisioning(tenantId: string, maxRetries = 3): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      const agents = await this.agentConfigService.list(tenantId);
      if (agents.length > 0) return;
      // Wait a bit for the sync handler to complete
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
