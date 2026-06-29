import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';

import { AgentMemoryService } from './services/agent-memory.service';
import { PersistInteractionDto } from './dto/persist-interaction.dto';
import { ClearMemoryDto } from './dto/clear-memory.dto';
import { CurrentTenant } from '@shared/decorators';
import { TenantContext } from '@shared/interfaces';
import { AgentContext, Interaction, LongTermEntry } from './interfaces/agent-memory.interface';

@Controller('agent-memory')
export class AgentMemoryController {
  constructor(private readonly agentMemoryService: AgentMemoryService) {}

  /**
   * GET /agent-memory/:agentId/context
   * Load full context (short-term + long-term) for an agent.
   */
  @Get(':agentId/context')
  async loadContext(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<AgentContext> {
    return this.agentMemoryService.loadContext(agentId, tenant.tenantId);
  }

  /**
   * POST /agent-memory/:agentId/interactions
   * Persist a new interaction to an agent's short-term memory.
   */
  @Post(':agentId/interactions')
  @HttpCode(HttpStatus.CREATED)
  async persistInteraction(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() dto: PersistInteractionDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<void> {
    await this.agentMemoryService.persistInteraction(agentId, {
      agentId,
      tenantId: tenant.tenantId,
      role: dto.role,
      content: dto.content,
      timestamp: new Date(),
      metadata: dto.metadata,
    });
  }

  /**
   * GET /agent-memory/:agentId/short-term
   * Get short-term memory (last 50 interactions).
   */
  @Get(':agentId/short-term')
  async getShortTerm(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<Interaction[]> {
    return this.agentMemoryService.getShortTermMemory(agentId, tenant.tenantId);
  }

  /**
   * GET /agent-memory/:agentId/long-term
   * Get long-term memory entries.
   */
  @Get(':agentId/long-term')
  async getLongTerm(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<LongTermEntry[]> {
    return this.agentMemoryService.getLongTermMemory(agentId, tenant.tenantId);
  }

  /**
   * POST /agent-memory/:agentId/promote
   * Manually trigger promotion from short-term to long-term.
   */
  @Post(':agentId/promote')
  @HttpCode(HttpStatus.NO_CONTENT)
  async promote(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<void> {
    await this.agentMemoryService.promoteToLongTerm(agentId, tenant.tenantId);
  }

  /**
   * POST /agent-memory/:agentId/clear
   * Clear agent memory (requires confirmation).
   */
  @Post(':agentId/clear')
  @HttpCode(HttpStatus.NO_CONTENT)
  async clearMemory(
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() dto: ClearMemoryDto,
  ): Promise<void> {
    await this.agentMemoryService.clearMemory(agentId, {
      type: dto.type,
      period: dto.period
        ? { start: new Date(dto.period.start), end: new Date(dto.period.end) }
        : undefined,
      requireConfirmation: dto.requireConfirmation,
    });
  }
}
