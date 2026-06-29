import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OnEvent } from '@nestjs/event-emitter';

import { AgentConfig, AgentType } from '../entities/agent-config.entity';
import { ConfigChange } from '../entities/config-change.entity';
import { UpdateAgentConfigDto } from '../dto/update-agent-config.dto';
import { IAgentConfigService } from '../interfaces/agent-config-service.interface';
import { TenantCreatedEvent } from '../interfaces/events.interface';

/**
 * Default agent configuration values used when provisioning new agents
 * or resetting to defaults.
 */
export const AGENT_DEFAULTS = {
  temperature: 0.7,
  maxTokens: 2048,
  knowledgeCategories: [] as string[],
  status: 'inactive' as const,
};

/**
 * The three default agents provisioned for every new tenant.
 */
const DEFAULT_AGENT_TYPES: AgentType[] = ['content', 'campaigns', 'customer_service'];

@Injectable()
export class AgentConfigService implements IAgentConfigService {
  private readonly logger = new Logger(AgentConfigService.name);

  constructor(
    @InjectRepository(AgentConfig)
    private readonly agentConfigRepository: Repository<AgentConfig>,
    @InjectRepository(ConfigChange)
    private readonly configChangeRepository: Repository<ConfigChange>,
  ) {}

  /**
   * Listen for tenant creation events and auto-provision default agents.
   */
  @OnEvent('tenant.created')
  async handleTenantCreated(event: TenantCreatedEvent): Promise<void> {
    this.logger.log(`Provisioning default agents for tenant ${event.tenantId}`);
    await this.provisionDefaults(event.tenantId);
  }

  /**
   * Provision 3 default agents (content, campaigns, customer_service) for a tenant.
   */
  async provisionDefaults(tenantId: string): Promise<AgentConfig[]> {
    const existingAgents = await this.agentConfigRepository.find({
      where: { tenantId },
    });

    // Only provision types that don't already exist
    const existingTypes = existingAgents.map((a) => a.agentType);
    const typesToProvision = DEFAULT_AGENT_TYPES.filter(
      (type) => !existingTypes.includes(type),
    );

    if (typesToProvision.length === 0) {
      return existingAgents;
    }

    const newAgents = typesToProvision.map((agentType) =>
      this.agentConfigRepository.create({
        tenantId,
        agentType,
        status: AGENT_DEFAULTS.status,
        temperature: AGENT_DEFAULTS.temperature,
        maxTokens: AGENT_DEFAULTS.maxTokens,
        knowledgeCategories: [...AGENT_DEFAULTS.knowledgeCategories],
        modelId: null,
        systemPromptId: null,
        fallbackModelId: null,
      }),
    );

    const saved = await this.agentConfigRepository.save(newAgents);
    return [...existingAgents, ...saved];
  }

  /**
   * List all agents for a tenant.
   */
  async list(tenantId: string): Promise<AgentConfig[]> {
    return this.agentConfigRepository.find({
      where: { tenantId },
      order: { agentType: 'ASC' },
    });
  }

  /**
   * Update agent configuration with parameter validation and history tracking.
   */
  async update(
    agentId: string,
    dto: UpdateAgentConfigDto,
    userId: string,
  ): Promise<AgentConfig> {
    const agent = await this.findAgentOrFail(agentId);

    // Validate temperature
    if (dto.temperature !== undefined) {
      if (dto.temperature < 0.0 || dto.temperature > 2.0) {
        throw new BadRequestException(
          'Temperature must be between 0.0 and 2.0',
        );
      }
    }

    // Validate maxTokens against model limits if model is set
    if (dto.maxTokens !== undefined) {
      await this.validateMaxTokens(dto.maxTokens, dto.modelId || agent.modelId);
    }

    // Track changes
    const changes: Partial<Record<keyof UpdateAgentConfigDto, { old: any; new: any }>> = {};

    if (dto.temperature !== undefined && dto.temperature !== agent.temperature) {
      changes.temperature = { old: agent.temperature, new: dto.temperature };
    }
    if (dto.maxTokens !== undefined && dto.maxTokens !== agent.maxTokens) {
      changes.maxTokens = { old: agent.maxTokens, new: dto.maxTokens };
    }
    if (dto.modelId !== undefined && dto.modelId !== agent.modelId) {
      changes.modelId = { old: agent.modelId, new: dto.modelId };
    }
    if (dto.systemPromptId !== undefined && dto.systemPromptId !== agent.systemPromptId) {
      changes.systemPromptId = { old: agent.systemPromptId, new: dto.systemPromptId };
    }
    if (dto.knowledgeCategories !== undefined) {
      const oldSorted = [...agent.knowledgeCategories].sort();
      const newSorted = [...dto.knowledgeCategories].sort();
      if (JSON.stringify(oldSorted) !== JSON.stringify(newSorted)) {
        changes.knowledgeCategories = {
          old: agent.knowledgeCategories,
          new: dto.knowledgeCategories,
        };
      }
    }
    if (dto.fallbackModelId !== undefined && dto.fallbackModelId !== agent.fallbackModelId) {
      changes.fallbackModelId = { old: agent.fallbackModelId, new: dto.fallbackModelId };
    }

    // Apply updates
    if (dto.temperature !== undefined) agent.temperature = dto.temperature;
    if (dto.maxTokens !== undefined) agent.maxTokens = dto.maxTokens;
    if (dto.modelId !== undefined) agent.modelId = dto.modelId;
    if (dto.systemPromptId !== undefined) agent.systemPromptId = dto.systemPromptId;
    if (dto.knowledgeCategories !== undefined) agent.knowledgeCategories = dto.knowledgeCategories;
    if (dto.fallbackModelId !== undefined) agent.fallbackModelId = dto.fallbackModelId;

    const saved = await this.agentConfigRepository.save(agent);

    // Record history
    await this.recordChanges(agentId, agent.tenantId, userId, changes);

    return saved;
  }

  /**
   * Activate an agent — sets status to 'active'.
   */
  async activate(agentId: string): Promise<void> {
    const agent = await this.findAgentOrFail(agentId);
    agent.status = 'active';
    await this.agentConfigRepository.save(agent);
  }

  /**
   * Deactivate an agent — sets status to 'inactive'.
   */
  async deactivate(agentId: string): Promise<void> {
    const agent = await this.findAgentOrFail(agentId);
    agent.status = 'inactive';
    await this.agentConfigRepository.save(agent);
  }

  /**
   * Reset agent to default parameters (temperature, maxTokens, knowledgeCategories).
   * Preserves agent memory and Knowledge Hub data.
   */
  async resetToDefaults(agentId: string): Promise<AgentConfig> {
    const agent = await this.findAgentOrFail(agentId);

    agent.temperature = AGENT_DEFAULTS.temperature;
    agent.maxTokens = AGENT_DEFAULTS.maxTokens;
    agent.knowledgeCategories = [...AGENT_DEFAULTS.knowledgeCategories];

    return this.agentConfigRepository.save(agent);
  }

  /**
   * Get configuration change history for an agent, ordered by most recent first.
   */
  async getConfigHistory(agentId: string): Promise<ConfigChange[]> {
    return this.configChangeRepository.find({
      where: { agentId },
      order: { changedAt: 'DESC' },
    });
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private async findAgentOrFail(agentId: string): Promise<AgentConfig> {
    const agent = await this.agentConfigRepository.findOne({
      where: { id: agentId },
    });
    if (!agent) {
      throw new NotFoundException(`Agent config not found: ${agentId}`);
    }
    return agent;
  }

  /**
   * Validate maxTokens against the model's max_output_tokens.
   * If no modelId is provided, only validates > 0.
   */
  private async validateMaxTokens(
    maxTokens: number,
    modelId: string | null,
  ): Promise<void> {
    if (maxTokens < 1) {
      throw new BadRequestException('maxTokens must be at least 1');
    }

    if (modelId) {
      // Query ai_models table to get the model's max_output_tokens
      const result = await this.agentConfigRepository.manager.query(
        `SELECT max_output_tokens FROM ai_models WHERE id = $1`,
        [modelId],
      );

      if (result.length > 0) {
        const modelMax = result[0].max_output_tokens;
        if (maxTokens > modelMax) {
          throw new BadRequestException(
            `maxTokens (${maxTokens}) exceeds model limit (${modelMax})`,
          );
        }
      }
    }
  }

  /**
   * Record configuration changes to the config_changes table.
   */
  private async recordChanges(
    agentId: string,
    tenantId: string,
    userId: string,
    changes: Record<string, { old: any; new: any }>,
  ): Promise<void> {
    const entries = Object.entries(changes);
    if (entries.length === 0) return;

    const records = entries.map(([field, { old: previousValue, new: newValue }]) =>
      this.configChangeRepository.create({
        agentId,
        tenantId,
        userId,
        field,
        previousValue,
        newValue,
      }),
    );

    await this.configChangeRepository.save(records);
  }
}
