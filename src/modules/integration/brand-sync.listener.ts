import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BrandService } from '../brand/services/brand.service';
import { BusinessMemoryService } from '../business-memory/services/business-memory.service';
import {
  BRAND_UPDATED_EVENT,
  BrandUpdatedPayload,
} from '../business-memory/interfaces/events.interface';

/**
 * Integration listener that wires brand identity updates to
 * business memory synchronization.
 *
 * When a brand is created or updated, this listener:
 * 1. Fetches the full brand data from BrandService
 * 2. Calls BusinessMemoryService.syncFromBrand with the complete brand data
 *
 * SLA: sync must complete within 60 seconds.
 *
 * Requirements: 6.2, 6.3
 */
@Injectable()
export class BrandSyncListener {
  private readonly logger = new Logger(BrandSyncListener.name);

  constructor(
    private readonly brandService: BrandService,
    private readonly businessMemoryService: BusinessMemoryService,
  ) {}

  /**
   * Handles 'brand.updated' events emitted by BrandService.
   * Fetches the full brand identity and syncs it into business memory.
   */
  @OnEvent(BRAND_UPDATED_EVENT, { async: true })
  async handleBrandUpdated(payload: BrandUpdatedPayload): Promise<void> {
    const startTime = Date.now();
    this.logger.log(
      `[BrandSyncListener] Received brand.updated event for tenant ${payload.tenantId}, action: ${payload.action}`,
    );

    try {
      // Fetch the full brand data
      const brand = await this.brandService.getByTenant(payload.tenantId);

      if (!brand) {
        this.logger.warn(
          `[BrandSyncListener] Brand not found for tenant ${payload.tenantId} after brand.updated event`,
        );
        return;
      }

      // Sync brand data into business memory
      await this.businessMemoryService.syncFromBrand(payload.tenantId, {
        voiceTone: brand.voiceTone,
        colorPalette: brand.colorPalette,
        logoUrl: brand.logoUrl,
        targetAudience: brand.targetAudience,
        differentials: brand.differentials,
        values: brand.values,
      });

      const durationMs = Date.now() - startTime;
      this.logger.log(
        `[BrandSyncListener] Brand → Business Memory sync completed for tenant ${payload.tenantId} in ${durationMs}ms`,
      );

      if (durationMs > 60000) {
        this.logger.warn(
          `[BrandSyncListener] Sync exceeded 60s SLA for tenant ${payload.tenantId}: ${durationMs}ms`,
        );
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `[BrandSyncListener] Failed to sync brand to business memory for tenant ${payload.tenantId}: ${err.message}`,
        err.stack,
      );
      // Resilience: do not throw — previous business memory version remains accessible
    }
  }
}
