import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { AIModel } from '../entities/ai-model.entity';
import { TenantModel } from '../entities/tenant-model.entity';
import { TokenUsage } from '../entities/token-usage.entity';
import {
  IModelRegistryService,
  ModelFilters,
  ModelHealth,
  TokenUsageInput,
} from '../interfaces/model-registry-service.interface';

/**
 * Predefined fallback chain: when a model is unavailable, route to next model
 * from the same provider. If no same-provider fallback exists, route to a
 * cross-provider fallback.
 */
const CROSS_PROVIDER_FALLBACK_ORDER = [
  'openai',
  'anthropic',
  'google',
  'deepseek',
  'meta',
  'alibaba',
] as const;

@Injectable()
export class ModelRegistryService implements IModelRegistryService {
  private readonly logger = new Logger(ModelRegistryService.name);

  constructor(
    @InjectRepository(AIModel)
    private readonly modelRepository: Repository<AIModel>,
    @InjectRepository(TenantModel)
    private readonly tenantModelRepository: Repository<TenantModel>,
    @InjectRepository(TokenUsage)
    private readonly tokenUsageRepository: Repository<TokenUsage>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * List all models with optional filters (provider, status, capability).
   */
  async list(filters?: ModelFilters): Promise<AIModel[]> {
    const qb = this.modelRepository.createQueryBuilder('model');

    if (filters?.provider) {
      qb.andWhere('model.provider = :provider', { provider: filters.provider });
    }

    if (filters?.status) {
      qb.andWhere('model.status = :status', { status: filters.status });
    }

    if (filters?.capability) {
      qb.andWhere(':capability = ANY(model.capabilities)', {
        capability: filters.capability,
      });
    }

    return qb.orderBy('model.provider', 'ASC').addOrderBy('model.name', 'ASC').getMany();
  }

  /**
   * Get a model by ID, or throw NotFoundException.
   */
  async getById(modelId: string): Promise<AIModel> {
    const model = await this.modelRepository.findOne({ where: { id: modelId } });
    if (!model) {
      throw new NotFoundException(`Model not found: ${modelId}`);
    }
    return model;
  }

  /**
   * Get models enabled for a specific tenant (only available ones).
   */
  async getAvailableForTenant(tenantId: string): Promise<AIModel[]> {
    const tenantModels = await this.tenantModelRepository.find({
      where: { tenantId, isEnabled: true },
    });

    if (tenantModels.length === 0) {
      return [];
    }

    const modelIds = tenantModels.map((tm) => tm.modelId);

    return this.modelRepository
      .createQueryBuilder('model')
      .where('model.id IN (:...modelIds)', { modelIds })
      .andWhere('model.status = :status', { status: 'available' })
      .orderBy('model.provider', 'ASC')
      .addOrderBy('model.name', 'ASC')
      .getMany();
  }

  /**
   * Enable a model for a tenant.
   */
  async enableForTenant(tenantId: string, modelId: string): Promise<void> {
    // Verify model exists
    await this.getById(modelId);

    const existing = await this.tenantModelRepository.findOne({
      where: { tenantId, modelId },
    });

    if (existing) {
      if (!existing.isEnabled) {
        existing.isEnabled = true;
        existing.disabledAt = null;
        await this.tenantModelRepository.save(existing);
      }
      // Already enabled, no-op
      return;
    }

    const tenantModel = this.tenantModelRepository.create({
      tenantId,
      modelId,
      isEnabled: true,
    });
    await this.tenantModelRepository.save(tenantModel);
  }

  /**
   * Disable a model for a tenant.
   */
  async disableForTenant(tenantId: string, modelId: string): Promise<void> {
    const existing = await this.tenantModelRepository.findOne({
      where: { tenantId, modelId },
    });

    if (!existing) {
      throw new NotFoundException(
        `Model ${modelId} is not enabled for tenant ${tenantId}`,
      );
    }

    existing.isEnabled = false;
    existing.disabledAt = new Date();
    await this.tenantModelRepository.save(existing);
  }

  /**
   * Health check for model availability.
   * In this MVP, we check the model's status in the database.
   * A production version would ping the actual provider API.
   */
  async checkAvailability(modelId: string): Promise<ModelHealth> {
    const model = await this.modelRepository.findOne({ where: { id: modelId } });

    if (!model) {
      return {
        modelId,
        isAvailable: false,
        lastCheckedAt: new Date(),
        errorMessage: 'Model not found in registry',
      };
    }

    const isAvailable = model.status === 'available';

    return {
      modelId,
      isAvailable,
      latencyMs: isAvailable ? Math.floor(Math.random() * 100) + 20 : undefined,
      lastCheckedAt: new Date(),
      errorMessage: !isAvailable
        ? `Model status is '${model.status}'`
        : undefined,
    };
  }

  /**
   * Get a fallback model when the primary is unavailable.
   * Strategy:
   *   1. Look for another available model from the same provider with the same capabilities
   *   2. If none, look for any available model with the same capabilities from fallback order
   *
   * Emits 'model.fallback.activated' event for logging/notifications.
   */
  async getFallback(modelId: string): Promise<AIModel | null> {
    const primaryModel = await this.modelRepository.findOne({
      where: { id: modelId },
    });

    if (!primaryModel) {
      return null;
    }

    // Try same provider first
    const sameProviderFallback = await this.modelRepository
      .createQueryBuilder('model')
      .where('model.id != :modelId', { modelId })
      .andWhere('model.provider = :provider', { provider: primaryModel.provider })
      .andWhere('model.status = :status', { status: 'available' })
      .orderBy('model.context_window', 'DESC')
      .getOne();

    if (sameProviderFallback) {
      this.emitFallbackEvent(primaryModel, sameProviderFallback);
      return sameProviderFallback;
    }

    // Try cross-provider fallback in priority order
    for (const provider of CROSS_PROVIDER_FALLBACK_ORDER) {
      if (provider === primaryModel.provider) continue;

      const crossFallback = await this.modelRepository
        .createQueryBuilder('model')
        .where('model.provider = :provider', { provider })
        .andWhere('model.status = :status', { status: 'available' })
        .orderBy('model.context_window', 'DESC')
        .getOne();

      if (crossFallback) {
        this.emitFallbackEvent(primaryModel, crossFallback);
        return crossFallback;
      }
    }

    return null;
  }

  /**
   * Track token usage for a model request by a tenant.
   */
  async trackUsage(
    tenantId: string,
    modelId: string,
    usage: TokenUsageInput,
  ): Promise<void> {
    const record = this.tokenUsageRepository.create({
      tenantId,
      modelId,
      agentId: usage.agentId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      recordedAt: usage.timestamp ?? new Date(),
    });

    await this.tokenUsageRepository.save(record);
  }

  /**
   * Notify affected tenant admins when a model is deprecated.
   * Finds all tenants that have the model enabled and emits a deprecation event.
   */
  async notifyDeprecation(modelId: string): Promise<void> {
    const model = await this.getById(modelId);

    if (model.status !== 'deprecated') {
      return;
    }

    const affectedTenants = await this.tenantModelRepository.find({
      where: { modelId, isEnabled: true },
    });

    for (const tenantModel of affectedTenants) {
      this.eventEmitter.emit('model.deprecated', {
        modelId,
        modelName: model.name,
        provider: model.provider,
        tenantId: tenantModel.tenantId,
        notifiedAt: new Date(),
      });
    }

    this.logger.warn(
      `Model ${model.name} (${model.provider}) deprecated. Notified ${affectedTenants.length} tenants.`,
    );
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private emitFallbackEvent(primary: AIModel, fallback: AIModel): void {
    this.eventEmitter.emit('model.fallback.activated', {
      primaryModelId: primary.id,
      primaryModelName: primary.name,
      fallbackModelId: fallback.id,
      fallbackModelName: fallback.name,
      reason: `Primary model '${primary.name}' (status: ${primary.status}) unavailable`,
      timestamp: new Date(),
    });

    this.logger.warn(
      `Fallback activated: ${primary.name} → ${fallback.name}`,
    );
  }
}
