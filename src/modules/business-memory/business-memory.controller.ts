import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  ForbiddenException,
  Headers,
} from '@nestjs/common';
import { BusinessMemoryService } from './services/business-memory.service';
import { RecordCampaignDto } from './dto/record-campaign.dto';
import { BusinessMemoryEntry, MemoryCategory } from './entities/business-memory-entry.entity';
import { BusinessMemorySnapshot } from './interfaces/business-memory.interface';
import { CurrentTenant } from '@shared/decorators';
import { TenantContext } from '@shared/interfaces';

@Controller('business-memory')
export class BusinessMemoryController {
  constructor(private readonly businessMemoryService: BusinessMemoryService) {}

  /**
   * GET /business-memory
   * Get all memory entries for the current tenant.
   * Accessible by both users and agents (read-only for agents).
   */
  @Get()
  async getAll(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<BusinessMemoryEntry[]> {
    return this.businessMemoryService.getByTenant(tenant.tenantId);
  }

  /**
   * GET /business-memory/category/:category
   * Get memory entries by category for the current tenant.
   * Accessible by both users and agents (read-only for agents).
   */
  @Get('category/:category')
  async getByCategory(
    @CurrentTenant() tenant: TenantContext,
    @Param('category') category: MemoryCategory,
  ): Promise<BusinessMemoryEntry[]> {
    const validCategories: MemoryCategory[] = [
      'brand', 'audience', 'campaigns', 'procedures', 'preferences',
    ];
    if (!validCategories.includes(category)) {
      throw new ForbiddenException(`Invalid category: ${category}`);
    }
    return this.businessMemoryService.getByCategory(tenant.tenantId, category);
  }

  /**
   * GET /business-memory/snapshot
   * Get a full snapshot of business memory for admin view.
   */
  @Get('snapshot')
  async getSnapshot(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<BusinessMemorySnapshot> {
    return this.businessMemoryService.getSnapshot(tenant.tenantId);
  }

  /**
   * POST /business-memory/campaigns
   * Record a campaign into business memory.
   * Rejects writes from agent context.
   */
  @Post('campaigns')
  async recordCampaign(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: RecordCampaignDto,
    @Headers('x-caller-type') callerType?: string,
  ): Promise<{ success: boolean }> {
    // Reject agent writes
    if (callerType === 'agent') {
      throw new ForbiddenException(
        'Agents cannot write to Business Memory. Business Memory is read-only for agents.',
      );
    }

    await this.businessMemoryService.recordCampaign(tenant.tenantId, {
      campaignId: dto.campaignId,
      name: dto.name,
      type: dto.type,
      status: dto.status,
      startedAt: new Date(dto.startedAt),
      completedAt: new Date(dto.completedAt),
      metrics: dto.metrics,
    });

    return { success: true };
  }

  /**
   * POST /business-memory/sync
   * Manual sync trigger (admin only). Rejects agent writes.
   */
  @Post('sync')
  async manualSync(
    @CurrentTenant() tenant: TenantContext,
    @Body() body: { source: 'brand' | 'clinic'; data: Record<string, any> },
    @Headers('x-caller-type') callerType?: string,
  ): Promise<{ success: boolean }> {
    // Reject agent writes
    if (callerType === 'agent') {
      throw new ForbiddenException(
        'Agents cannot write to Business Memory. Business Memory is read-only for agents.',
      );
    }

    if (body.source === 'brand') {
      await this.businessMemoryService.syncFromBrand(tenant.tenantId, body.data);
    } else {
      await this.businessMemoryService.syncFromClinic(tenant.tenantId, body.data);
    }

    return { success: true };
  }
}
