import {
  Injectable,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import {
  BusinessMemoryEntry,
  MemoryCategory,
} from '../entities/business-memory-entry.entity';
import {
  BusinessMemorySnapshot,
  CampaignMetadata,
  MemoryEntrySummary,
} from '../interfaces/business-memory.interface';
import {
  CLINIC_CREATED_EVENT,
  CLINIC_UPDATED_EVENT,
  CAMPAIGN_COMPLETED_EVENT,
  ClinicCreatedPayload,
  ClinicUpdatedPayload,
  CampaignCompletedPayload,
} from '../interfaces/events.interface';

@Injectable()
export class BusinessMemoryService {
  private readonly logger = new Logger(BusinessMemoryService.name);

  constructor(
    @InjectRepository(BusinessMemoryEntry)
    private readonly memoryRepository: Repository<BusinessMemoryEntry>,
  ) {}

  /**
   * Get all memory entries for a tenant.
   */
  async getByTenant(tenantId: string): Promise<BusinessMemoryEntry[]> {
    return this.memoryRepository.find({
      where: { tenantId },
      order: { category: 'ASC', key: 'ASC' },
    });
  }

  /**
   * Get memory entries filtered by category for a tenant.
   */
  async getByCategory(
    tenantId: string,
    category: MemoryCategory,
  ): Promise<BusinessMemoryEntry[]> {
    return this.memoryRepository.find({
      where: { tenantId, category },
      order: { key: 'ASC' },
    });
  }

  /**
   * Sync memory from brand data.
   * Called internally by the event listener. Implements resilience:
   * on failure, logs error and keeps the previous version accessible.
   */
  async syncFromBrand(
    tenantId: string,
    brandData: Record<string, any>,
  ): Promise<void> {
    try {
      const entries: Array<{ key: string; value: any; category: MemoryCategory }> = [];

      if (brandData.voiceTone !== undefined) {
        entries.push({ key: 'voice_tone', value: brandData.voiceTone, category: 'brand' });
      }
      if (brandData.colorPalette !== undefined) {
        entries.push({ key: 'color_palette', value: brandData.colorPalette, category: 'brand' });
      }
      if (brandData.logoUrl !== undefined) {
        entries.push({ key: 'logo_url', value: brandData.logoUrl, category: 'brand' });
      }
      if (brandData.differentials !== undefined) {
        entries.push({ key: 'differentials', value: brandData.differentials, category: 'brand' });
      }
      if (brandData.values !== undefined) {
        entries.push({ key: 'values', value: brandData.values, category: 'brand' });
      }
      if (brandData.targetAudience !== undefined) {
        entries.push({ key: 'target_audience', value: brandData.targetAudience, category: 'audience' });
      }

      for (const entry of entries) {
        await this.upsertEntry(tenantId, entry.category, entry.key, entry.value, 'system');
      }

      this.logger.log(`Business memory synced from brand for tenant ${tenantId}`);
    } catch (error: unknown) {
      // Resilience: on sync failure, log error and keep previous version accessible
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Failed to sync business memory from brand for tenant ${tenantId}: ${err.message}`,
        err.stack,
      );
    }
  }

  /**
   * Sync memory from clinic data.
   * Called internally by the event listener.
   */
  async syncFromClinic(
    tenantId: string,
    clinicData: Record<string, any>,
  ): Promise<void> {
    try {
      const entries: Array<{ key: string; value: any; category: MemoryCategory }> = [];

      if (clinicData.name !== undefined) {
        entries.push({ key: 'clinic_name', value: clinicData.name, category: 'brand' });
      }
      if (clinicData.specialties !== undefined) {
        entries.push({ key: 'specialties', value: clinicData.specialties, category: 'procedures' });
      }
      if (clinicData.targetAudience !== undefined) {
        entries.push({ key: 'clinic_target_audience', value: clinicData.targetAudience, category: 'audience' });
      }
      if (clinicData.phone !== undefined) {
        entries.push({ key: 'clinic_phone', value: clinicData.phone, category: 'preferences' });
      }
      if (clinicData.email !== undefined) {
        entries.push({ key: 'clinic_email', value: clinicData.email, category: 'preferences' });
      }
      if (clinicData.website !== undefined) {
        entries.push({ key: 'clinic_website', value: clinicData.website, category: 'preferences' });
      }

      for (const entry of entries) {
        await this.upsertEntry(tenantId, entry.category, entry.key, entry.value, 'system');
      }

      this.logger.log(`Business memory synced from clinic for tenant ${tenantId}`);
    } catch (error: unknown) {
      // Resilience: on sync failure, log error and keep previous version accessible
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Failed to sync business memory from clinic for tenant ${tenantId}: ${err.message}`,
        err.stack,
      );
    }
  }

  /**
   * Record campaign metadata into the campaigns category.
   */
  async recordCampaign(tenantId: string, campaign: CampaignMetadata): Promise<void> {
    const key = `campaign_${campaign.campaignId}`;
    await this.upsertEntry(tenantId, 'campaigns', key, campaign, 'system');
    this.logger.log(
      `Campaign recorded in business memory for tenant ${tenantId}: ${campaign.name}`,
    );
  }

  /**
   * Returns a snapshot of all categories with last update timestamps.
   * Used by admin view.
   */
  async getSnapshot(tenantId: string): Promise<BusinessMemorySnapshot> {
    const entries = await this.memoryRepository.find({
      where: { tenantId },
      order: { updatedAt: 'DESC' },
    });

    const categories: Record<MemoryCategory, MemoryEntrySummary[]> = {
      brand: [],
      audience: [],
      campaigns: [],
      procedures: [],
      preferences: [],
    };

    let lastUpdated: Date | null = null;

    for (const entry of entries) {
      categories[entry.category].push({
        key: entry.key,
        value: entry.value,
        version: entry.version,
        updatedAt: entry.updatedAt,
        updatedBy: entry.updatedBy,
      });

      if (!lastUpdated || entry.updatedAt > lastUpdated) {
        lastUpdated = entry.updatedAt;
      }
    }

    return {
      tenantId,
      categories,
      lastUpdated,
    };
  }

  /**
   * Validate that the caller is NOT an agent.
   * Agents can read but CANNOT write to business memory.
   * Throws ForbiddenException for agent write attempts.
   */
  validateNotAgent(caller: string): void {
    if (caller === 'agent') {
      throw new ForbiddenException(
        'Agents cannot write to Business Memory. Business Memory is read-only for agents.',
      );
    }
  }

  // --- Event Listeners ---

  // NOTE: brand.updated event handling has been moved to
  // src/modules/integration/brand-sync.listener.ts (BrandSyncListener)
  // which fetches full brand data and calls syncFromBrand() directly.

  /**
   * Handles clinic.created events. Auto-syncs clinic data into business memory.
   * Must complete within 60s SLA.
   */
  @OnEvent(CLINIC_CREATED_EVENT, { async: true })
  async handleClinicCreated(payload: ClinicCreatedPayload): Promise<void> {
    const clinic = payload.clinic;
    this.logger.log(
      `Received clinic.created event for tenant ${clinic.tenantId}`,
    );
    await this.syncFromClinic(clinic.tenantId, clinic);
  }

  /**
   * Handles clinic.updated events. Auto-syncs clinic data into business memory.
   * Must complete within 60s SLA.
   */
  @OnEvent(CLINIC_UPDATED_EVENT, { async: true })
  async handleClinicUpdated(payload: ClinicUpdatedPayload): Promise<void> {
    const clinic = payload.clinic;
    this.logger.log(
      `Received clinic.updated event for tenant ${clinic.tenantId}, fields: ${payload.updatedFields.join(', ')}`,
    );
    await this.syncFromClinic(clinic.tenantId, clinic);
  }

  /**
   * Handles campaign.completed events. Records campaign metadata in business memory.
   */
  @OnEvent(CAMPAIGN_COMPLETED_EVENT, { async: true })
  async handleCampaignCompleted(payload: CampaignCompletedPayload): Promise<void> {
    this.logger.log(
      `Received campaign.completed event for tenant ${payload.tenantId}: ${payload.name}`,
    );
    await this.recordCampaign(payload.tenantId, {
      campaignId: payload.campaignId,
      name: payload.name,
      type: payload.type,
      status: payload.status,
      startedAt: payload.startedAt,
      completedAt: payload.completedAt,
      metrics: payload.metrics,
    });
  }

  // --- Private Helpers ---

  /**
   * Upserts a memory entry: if key exists for the tenant+category, update it
   * and bump version; otherwise insert a new entry.
   */
  private async upsertEntry(
    tenantId: string,
    category: MemoryCategory,
    key: string,
    value: any,
    updatedBy: string,
  ): Promise<BusinessMemoryEntry> {
    const existing = await this.memoryRepository.findOne({
      where: { tenantId, category, key },
    });

    if (existing) {
      existing.value = value;
      existing.version = existing.version + 1;
      existing.updatedBy = updatedBy;
      return this.memoryRepository.save(existing);
    }

    const entry = this.memoryRepository.create({
      tenantId,
      category,
      key,
      value,
      version: 1,
      updatedBy,
    });

    return this.memoryRepository.save(entry);
  }
}
