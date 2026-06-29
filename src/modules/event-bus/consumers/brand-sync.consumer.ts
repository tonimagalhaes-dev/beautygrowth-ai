import { Injectable, Logger } from '@nestjs/common';
import { OnDistributedEvent } from '../decorators/on-distributed-event.decorator';
import { BrandUpdatedPayloadDto } from '../dto/brand-updated-payload.dto';

/**
 * Distributed consumer for brand sync events.
 * Replaces BrandSyncListener (EventEmitter2) for distributed processing.
 * Handles brand.updated events to sync brand data with Business Memory within 60s SLA.
 *
 * During the transition period, BrandSyncListener remains active via dual-emit
 * so both local (EventEmitter2) and distributed (BullMQ) paths coexist.
 *
 * @see Requirements 2.2, 2.5
 */
@Injectable()
export class BrandSyncConsumer {
  private readonly logger = new Logger(BrandSyncConsumer.name);

  @OnDistributedEvent('brand.updated')
  async handleBrandSync(payload: BrandUpdatedPayloadDto): Promise<void> {
    const startTime = Date.now();
    this.logger.log(
      `Syncing brand ${payload.brandId} (action: ${payload.action}) for tenant ${payload.tenantId} (correlationId: ${payload.correlationId})`,
    );

    // TODO: Inject and connect to BrandService + BusinessMemoryService for full sync logic.
    // During Phase 1 (dual-emit), the BrandSyncListener handles the actual sync via EventEmitter2.
    // Once fully migrated, this consumer will:
    // 1. Fetch full brand data via BrandService.getByTenant(payload.tenantId)
    // 2. Call BusinessMemoryService.syncFromBrand(tenantId, brandData)
    // 3. Monitor SLA compliance (60s)

    const durationMs = Date.now() - startTime;
    this.logger.log(
      `Brand sync handler completed for tenant ${payload.tenantId} in ${durationMs}ms`,
    );

    if (durationMs > 60000) {
      this.logger.warn(
        `Brand sync exceeded 60s SLA for tenant ${payload.tenantId}: ${durationMs}ms`,
      );
    }
  }
}
