import { Injectable, Logger } from '@nestjs/common';
import { OnDistributedEvent } from '../decorators/on-distributed-event.decorator';
import { TenantCreatedPayloadDto } from '../dto/tenant-created-payload.dto';

/**
 * Distributed consumer for tenant provisioning events.
 * Replaces TenantProvisioningListener (EventEmitter2) for distributed processing.
 * The original listener remains active during the dual-emit transition period.
 *
 * Handles:
 * - Knowledge Hub initialization for new tenants
 * - Business Memory initialization for new tenants
 *
 * @see Requirements 2.1, 2.5
 */
@Injectable()
export class TenantProvisioningConsumer {
  private readonly logger = new Logger(TenantProvisioningConsumer.name);

  /**
   * Initializes the Knowledge Hub for a newly created tenant.
   * Migrated from TenantProvisioningListener.handleKnowledgeHubInit().
   */
  @OnDistributedEvent('tenant.created')
  async handleKnowledgeHubInit(payload: TenantCreatedPayloadDto): Promise<void> {
    this.logger.log(
      `Initializing Knowledge Hub for tenant ${payload.tenantId} (correlationId: ${payload.correlationId})`,
    );
    // TODO: Connect to KnowledgeHubService when available
    // await this.knowledgeHubService.initForTenant(payload.tenantId);
  }

  /**
   * Initializes the Business Memory for a newly created tenant.
   * Migrated from TenantProvisioningListener.handleBusinessMemoryInit().
   */
  @OnDistributedEvent('tenant.created')
  async handleBusinessMemoryInit(
    payload: TenantCreatedPayloadDto,
  ): Promise<void> {
    this.logger.log(
      `Initializing Business Memory for tenant ${payload.tenantId} (correlationId: ${payload.correlationId})`,
    );
    // TODO: Connect to BusinessMemoryService when available
    // await this.businessMemoryService.initForTenant(payload.tenantId);
  }
}
