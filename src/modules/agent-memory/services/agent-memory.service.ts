import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AgentMemoryShort } from '../entities/agent-memory-short.entity';
import { AgentMemoryLong } from '../entities/agent-memory-long.entity';
import {
  AgentContext,
  ClearOptions,
  IAgentMemoryService,
  Interaction,
  LongTermEntry,
} from '../interfaces/agent-memory.interface';

/**
 * Maximum number of short-term interactions per agent.
 */
export const SHORT_TERM_LIMIT = 50;

@Injectable()
export class AgentMemoryService implements IAgentMemoryService {
  private readonly logger = new Logger(AgentMemoryService.name);

  constructor(
    @InjectRepository(AgentMemoryShort)
    private readonly shortTermRepo: Repository<AgentMemoryShort>,
    @InjectRepository(AgentMemoryLong)
    private readonly longTermRepo: Repository<AgentMemoryLong>,
  ) {}

  /**
   * Load full context for an agent: short-term + long-term memory.
   * SLA: 5s max response time.
   */
  async loadContext(agentId: string, tenantId: string): Promise<AgentContext> {
    const [shortTerm, longTerm] = await Promise.all([
      this.getShortTermMemory(agentId, tenantId),
      this.getLongTermMemory(agentId, tenantId),
    ]);

    const lastInteraction = shortTerm.length > 0 ? shortTerm[0].timestamp : null;

    return {
      shortTerm,
      longTerm,
      metadata: {
        agentId,
        tenantId,
        shortTermCount: shortTerm.length,
        longTermCount: longTerm.length,
        lastInteractionAt: lastInteraction,
      },
    };
  }

  /**
   * Persist a new interaction to short-term memory.
   * If the count reaches the limit (50), auto-promotes oldest interactions to long-term.
   * SLA: 10s max response time.
   *
   * On persistence failure: logs the error and does NOT throw — keeps session active.
   */
  async persistInteraction(
    agentId: string,
    interaction: Omit<Interaction, 'id'>,
  ): Promise<void> {
    try {
      // Save the new interaction
      const entity = this.shortTermRepo.create({
        agentId,
        tenantId: interaction.tenantId,
        role: interaction.role,
        content: interaction.content,
        metadata: interaction.metadata || null,
      });

      await this.shortTermRepo.save(entity);

      // Check if we need to auto-promote
      const count = await this.shortTermRepo.count({
        where: { agentId, tenantId: interaction.tenantId },
      });

      if (count > SHORT_TERM_LIMIT) {
        await this.promoteToLongTerm(agentId, interaction.tenantId);
      }
    } catch (error: unknown) {
      // On persistence failure: log error, notify admin, keep session active
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Failed to persist interaction for agent ${agentId}: ${message}`,
        stack,
      );
      // Do NOT re-throw — session must remain active
    }
  }

  /**
   * Promote oldest short-term interactions to long-term when count exceeds limit.
   * Summarizes the oldest interactions and stores as a long-term entry.
   * Then removes the promoted interactions from short-term.
   */
  async promoteToLongTerm(agentId: string, tenantId?: string): Promise<void> {
    // Resolve tenantId if not provided
    let resolvedTenantId = tenantId;
    if (!resolvedTenantId) {
      const sample = await this.shortTermRepo.findOne({
        where: { agentId },
        order: { createdAt: 'DESC' },
      });
      if (!sample) return;
      resolvedTenantId = sample.tenantId;
    }

    const count = await this.shortTermRepo.count({
      where: { agentId, tenantId: resolvedTenantId },
    });

    if (count <= SHORT_TERM_LIMIT) return;

    // Get the oldest interactions that exceed the limit
    const allInteractions = await this.shortTermRepo.find({
      where: { agentId, tenantId: resolvedTenantId },
      order: { createdAt: 'ASC' },
    });

    const excessCount = count - SHORT_TERM_LIMIT;
    const toPromote = allInteractions.slice(0, excessCount);

    if (toPromote.length === 0) return;

    // Summarize the interactions (stub: concatenate content)
    const summary = this.summarizeInteractions(toPromote);
    const sourceIds = toPromote.map((i) => i.id);

    // Create long-term entry
    const longTermEntry = this.longTermRepo.create({
      agentId,
      tenantId: resolvedTenantId,
      type: 'learning',
      summary,
      confidence: 0.7, // default confidence for auto-promoted summaries
      sourceInteractions: sourceIds,
    });

    await this.longTermRepo.save(longTermEntry);

    // Remove promoted interactions from short-term
    await this.shortTermRepo.remove(toPromote);

    this.logger.log(
      `Promoted ${toPromote.length} interactions to long-term for agent ${agentId}`,
    );
  }

  /**
   * Clear agent memory with options.
   * Requires confirmation flag to be true, otherwise throws.
   */
  async clearMemory(agentId: string, options: ClearOptions): Promise<void> {
    if (!options.requireConfirmation) {
      throw new BadRequestException(
        'Memory clearing requires confirmation (requireConfirmation must be true)',
      );
    }

    if (options.type === 'all' || options.type === 'short_term') {
      if (options.period) {
        await this.shortTermRepo
          .createQueryBuilder()
          .delete()
          .from(AgentMemoryShort)
          .where('agent_id = :agentId', { agentId })
          .andWhere('created_at >= :start', { start: options.period.start })
          .andWhere('created_at <= :end', { end: options.period.end })
          .execute();
      } else {
        await this.shortTermRepo.delete({ agentId });
      }
    }

    if (options.type === 'all' || options.type === 'long_term') {
      if (options.period) {
        await this.longTermRepo
          .createQueryBuilder()
          .delete()
          .from(AgentMemoryLong)
          .where('agent_id = :agentId', { agentId })
          .andWhere('created_at >= :start', { start: options.period.start })
          .andWhere('created_at <= :end', { end: options.period.end })
          .execute();
      } else {
        await this.longTermRepo.delete({ agentId });
      }
    }

    this.logger.log(
      `Cleared ${options.type} memory for agent ${agentId}`,
    );
  }

  /**
   * Get short-term memory (last 50 interactions, ordered by most recent first).
   * Enforces agent isolation by requiring agentId filter.
   */
  async getShortTermMemory(agentId: string, tenantId?: string): Promise<Interaction[]> {
    const where: any = { agentId };
    if (tenantId) where.tenantId = tenantId;

    const records = await this.shortTermRepo.find({
      where,
      order: { createdAt: 'DESC' },
      take: SHORT_TERM_LIMIT,
    });

    return records.map((r) => this.mapShortTermToInteraction(r));
  }

  /**
   * Get long-term memory entries for an agent.
   * Enforces agent isolation by requiring agentId filter.
   */
  async getLongTermMemory(agentId: string, tenantId?: string): Promise<LongTermEntry[]> {
    const where: any = { agentId };
    if (tenantId) where.tenantId = tenantId;

    const records = await this.longTermRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });

    return records.map((r) => this.mapLongTermToEntry(r));
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  /**
   * Summarize a set of interactions into a single summary string.
   * For now, this is a simple stub that concatenates content.
   * In the future, this could use an LLM to generate a more meaningful summary.
   */
  private summarizeInteractions(interactions: AgentMemoryShort[]): string {
    const parts = interactions.map(
      (i) => `[${i.role}]: ${i.content}`,
    );
    return `Summary of ${interactions.length} interactions: ${parts.join(' | ')}`;
  }

  private mapShortTermToInteraction(record: AgentMemoryShort): Interaction {
    return {
      id: record.id,
      agentId: record.agentId,
      tenantId: record.tenantId,
      role: record.role,
      content: record.content,
      timestamp: record.createdAt,
      metadata: record.metadata || undefined,
    };
  }

  private mapLongTermToEntry(record: AgentMemoryLong): LongTermEntry {
    return {
      id: record.id,
      agentId: record.agentId,
      tenantId: record.tenantId,
      type: record.type,
      summary: record.summary,
      confidence: record.confidence,
      createdAt: record.createdAt,
      sourceInteractions: record.sourceInteractions,
    };
  }
}
