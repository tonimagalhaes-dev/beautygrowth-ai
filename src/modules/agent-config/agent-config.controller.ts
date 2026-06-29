import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AgentConfigService } from './services/agent-config.service';
import { UpdateAgentConfigDto } from './dto/update-agent-config.dto';
import { AgentConfig } from './entities/agent-config.entity';
import { ConfigChange } from './entities/config-change.entity';
import { CurrentTenant } from '@shared/decorators';
import { TenantContext } from '@shared/interfaces';

@Controller('agent-configs')
export class AgentConfigController {
  constructor(private readonly agentConfigService: AgentConfigService) {}

  /**
   * GET /agent-configs
   * List all agent configurations for the current tenant.
   */
  @Get()
  async list(@CurrentTenant() tenant: TenantContext): Promise<AgentConfig[]> {
    return this.agentConfigService.list(tenant.tenantId);
  }

  /**
   * POST /agent-configs/provision
   * Manually provision default agents for the current tenant.
   */
  @Post('provision')
  async provision(@CurrentTenant() tenant: TenantContext): Promise<AgentConfig[]> {
    return this.agentConfigService.provisionDefaults(tenant.tenantId);
  }

  /**
   * PATCH /agent-configs/:id
   * Update an agent's configuration parameters.
   */
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAgentConfigDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<AgentConfig> {
    return this.agentConfigService.update(id, dto, tenant.userId);
  }

  /**
   * POST /agent-configs/:id/activate
   * Activate an agent.
   */
  @Post(':id/activate')
  @HttpCode(HttpStatus.NO_CONTENT)
  async activate(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.agentConfigService.activate(id);
  }

  /**
   * POST /agent-configs/:id/deactivate
   * Deactivate an agent.
   */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivate(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.agentConfigService.deactivate(id);
  }

  /**
   * POST /agent-configs/:id/reset
   * Reset an agent's configuration to defaults (preserves memory and Knowledge Hub).
   */
  @Post(':id/reset')
  async resetToDefaults(@Param('id', ParseUUIDPipe) id: string): Promise<AgentConfig> {
    return this.agentConfigService.resetToDefaults(id);
  }

  /**
   * GET /agent-configs/:id/history
   * Get configuration change history for an agent.
   */
  @Get(':id/history')
  async getHistory(@Param('id', ParseUUIDPipe) id: string): Promise<ConfigChange[]> {
    return this.agentConfigService.getConfigHistory(id);
  }
}
