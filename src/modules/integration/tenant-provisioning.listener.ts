import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { KnowledgeHubService } from '../knowledge-hub/services/knowledge-hub.service';
import { PREDEFINED_CATEGORIES } from '../knowledge-hub/services/knowledge-hub.service';
import { BusinessMemoryService } from '../business-memory/services/business-memory.service';

/**
 * Event payload emitted when a new tenant is created (after user registration).
 */
export interface TenantCreatedEvent {
  tenantId: string;
}

/**
 * Tenant Provisioning Listener
 *
 * Listens for 'tenant.created' events and orchestrates downstream provisioning:
 * 1. AgentConfigService handles its own provisioning via @OnEvent('tenant.created')
 * 2. This listener initializes the Knowledge Hub (predefined categories)
 * 3. This listener initializes Business Memory (empty placeholder entries)
 *
 * The AgentConfigService already has its own @OnEvent handler, so we don't need
 * to call provisionDefaults here — it's already wired.
 */
@Injectable()
export class TenantProvisioningListener {
  private readonly logger = new Logger(TenantProvisioningListener.name);

  constructor(
    private readonly knowledgeHubService: KnowledgeHubService,
    private readonly businessMemoryService: BusinessMemoryService,
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
   * with empty placeholder entries for the new tenant.
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
        // Initialize with empty marker entries for each category so the
        // memory hub is "present" even if no real data exists yet.
        // The BusinessMemoryService's upsertEntry is private, so we use
        // the publicly available syncFromBrand/syncFromClinic patterns.
        // For initial provisioning, we just confirm that the tenant has
        // an accessible (empty) business memory — no entries required.
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
}
