import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ModelRegistryService } from './services/model-registry.service';
import { ModelFiltersDto } from './dto/model-filters.dto';
import { TrackUsageDto } from './dto/track-usage.dto';
import { AIModel } from './entities/ai-model.entity';
import { ModelHealth } from './interfaces/model-registry-service.interface';
import { CurrentTenant } from '@shared/decorators';
import { TenantContext } from '@shared/interfaces';

@Controller('model-registry')
export class ModelRegistryController {
  constructor(private readonly modelRegistryService: ModelRegistryService) {}

  /**
   * GET /model-registry
   * List all models with optional filters.
   */
  @Get()
  async list(@Query() filters: ModelFiltersDto): Promise<AIModel[]> {
    return this.modelRegistryService.list(filters);
  }

  /**
   * GET /model-registry/available
   * Get models available (enabled) for the current tenant.
   */
  @Get('available')
  async getAvailableForTenant(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<AIModel[]> {
    return this.modelRegistryService.getAvailableForTenant(tenant.tenantId);
  }

  /**
   * GET /model-registry/:id
   * Get a specific model by ID.
   */
  @Get(':id')
  async getById(@Param('id', ParseUUIDPipe) id: string): Promise<AIModel> {
    return this.modelRegistryService.getById(id);
  }

  /**
   * GET /model-registry/:id/health
   * Check if a model is available/healthy.
   */
  @Get(':id/health')
  async checkHealth(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ModelHealth> {
    return this.modelRegistryService.checkAvailability(id);
  }

  /**
   * GET /model-registry/:id/fallback
   * Get the fallback model for a given model.
   */
  @Get(':id/fallback')
  async getFallback(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AIModel | null> {
    return this.modelRegistryService.getFallback(id);
  }

  /**
   * POST /model-registry/:id/enable
   * Enable a model for the current tenant.
   */
  @Post(':id/enable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async enable(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<void> {
    return this.modelRegistryService.enableForTenant(tenant.tenantId, id);
  }

  /**
   * POST /model-registry/:id/disable
   * Disable a model for the current tenant.
   */
  @Post(':id/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  async disable(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<void> {
    return this.modelRegistryService.disableForTenant(tenant.tenantId, id);
  }

  /**
   * POST /model-registry/:id/usage
   * Record token usage for a model request.
   */
  @Post(':id/usage')
  @HttpCode(HttpStatus.CREATED)
  async trackUsage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TrackUsageDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<void> {
    return this.modelRegistryService.trackUsage(tenant.tenantId, id, {
      inputTokens: dto.inputTokens,
      outputTokens: dto.outputTokens,
      agentId: dto.agentId,
    });
  }

  /**
   * POST /model-registry/:id/notify-deprecation
   * Manually trigger deprecation notification for a model.
   */
  @Post(':id/notify-deprecation')
  @HttpCode(HttpStatus.NO_CONTENT)
  async notifyDeprecation(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.modelRegistryService.notifyDeprecation(id);
  }
}
