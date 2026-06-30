import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Guardrail } from '../entities/guardrail.entity';
import { GuardrailViolation } from '../entities/guardrail-violation.entity';
import { GuardrailVersion } from '../entities/guardrail-version.entity';
import { CreateGuardrailDto } from '../dto/create-guardrail.dto';
import { UpdateGuardrailDto } from '../dto/update-guardrail.dto';
import {
  IGuardrailsService,
  ValidationResult,
  Violation,
  DateRange,
  ViolationReport,
  GuardrailRule,
  RegenerationResult,
} from '../interfaces/guardrails-service.interface';
import { ICacheService } from '../../cache/interfaces/cache-service.interface';
import { CacheKeyBuilder } from '../../cache/services/cache-key-builder.service';
import {
  CACHE_SERVICE,
  GUARDRAILS_TENANT_TTL,
  GUARDRAILS_SYSTEM_TTL,
} from '../../cache/config/cache.constants';

/**
 * Default system guardrails that cannot be disabled, edited, or deleted.
 * These enforce immutable safety rules for all tenants.
 */
const SYSTEM_GUARDRAILS_DEFINITIONS: Array<{
  name: string;
  description: string;
  rule: GuardrailRule;
}> = [
  {
    name: 'no-health-promises',
    description: 'Proíbe promessas de resultados de saúde ou estéticos garantidos',
    rule: {
      pattern:
        '\\b(garanti[a-z]*|certeza de resultado|100%|resultado garantido|prometo|assegur[a-z]*)\\b.*\\b(resultado|cur[a-z]*|emagrec[a-z]*|rejuvenesc[a-z]*)\\b',
      categories: ['health_promise'],
      action: 'regenerate',
      maxRetries: 3,
    },
  },
  {
    name: 'no-diagnoses',
    description: 'Proíbe diagnósticos médicos ou de saúde',
    rule: {
      pattern:
        '\\b(diagnóstic[a-z]*|diagnostica[a-z]*|você tem|você sofre de|sua condição é|patologia)\\b',
      categories: ['diagnosis'],
      action: 'block',
      maxRetries: 3,
    },
  },
  {
    name: 'no-prescriptions',
    description: 'Proíbe prescrições de medicamentos ou tratamentos médicos',
    rule: {
      pattern:
        '\\b(prescrev[a-z]*|receitar|tome|use.*mg|aplique.*vezes ao dia|medicament[a-z]*|remédio)\\b',
      categories: ['prescription'],
      action: 'block',
      maxRetries: 3,
    },
  },
  {
    name: 'no-anvisa-cfm-violations',
    description: 'Proíbe conteúdo que viole regulamentações ANVISA/CFM',
    rule: {
      pattern:
        '\\b(antes e depois|fotos comparativas de pacientes|resultado de outro paciente|propaganda enganosa)\\b',
      categories: ['regulatory_violation'],
      action: 'block',
      maxRetries: 3,
    },
  },
  {
    name: 'no-cross-tenant-data',
    description: 'Proíbe compartilhamento de dados entre tenants',
    rule: {
      pattern:
        '\\b(outra clínica|outro consultório|dados do paciente de|informações de outro)\\b',
      categories: ['cross_tenant_data'],
      action: 'block',
      maxRetries: 3,
    },
  },
];

@Injectable()
export class GuardrailsService implements IGuardrailsService {
  private readonly logger = new Logger(GuardrailsService.name);

  constructor(
    @InjectRepository(Guardrail)
    private readonly guardrailRepository: Repository<Guardrail>,
    @InjectRepository(GuardrailViolation)
    private readonly violationRepository: Repository<GuardrailViolation>,
    @InjectRepository(GuardrailVersion)
    private readonly versionRepository: Repository<GuardrailVersion>,
    private readonly eventEmitter: EventEmitter2,
    @Inject(CACHE_SERVICE) private readonly cache: ICacheService,
    private readonly keyBuilder: CacheKeyBuilder,
  ) {}

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  /**
   * Validate content against all applicable guardrails (system + tenant).
   * Returns validation result with any violations found.
   */
  async validate(
    content: string,
    tenantId: string,
    agentId?: string,
  ): Promise<ValidationResult> {
    const guardrails = await this.getActiveGuardrails(tenantId);
    const violations: Violation[] = [];

    for (const guardrail of guardrails) {
      const violation = this.checkGuardrail(content, guardrail);
      if (violation) {
        violations.push(violation);
      }
    }

    // Log violations if any
    if (violations.length > 0) {
      await this.logViolations(tenantId, content, violations, agentId);
    }

    return {
      isValid: violations.length === 0,
      violations,
      checkedGuardrails: guardrails.length,
    };
  }

  /**
   * Validate with regeneration logic: on violation, signals regeneration (max retries then block).
   */
  async validateWithRegeneration(
    content: string,
    tenantId: string,
    agentId: string | undefined,
    attempt: number,
  ): Promise<RegenerationResult> {
    const result = await this.validate(content, tenantId, agentId);

    if (result.isValid) {
      return {
        success: true,
        attempt,
        maxRetries: 3,
        blocked: false,
        violations: [],
      };
    }

    // Determine max retries from the first violation's guardrail
    const maxRetries = await this.getMaxRetries(result.violations[0]?.guardrailId);

    if (attempt >= maxRetries) {
      // Max retries reached — block content
      await this.logViolationAction(
        tenantId,
        content,
        result.violations,
        agentId,
        'blocked',
        attempt,
      );

      return {
        success: false,
        attempt,
        maxRetries,
        blocked: true,
        violations: result.violations,
      };
    }

    // Signal regeneration needed
    await this.logViolationAction(
      tenantId,
      content,
      result.violations,
      agentId,
      'regenerated',
      attempt,
    );

    this.eventEmitter.emit('guardrails.violation', {
      tenantId,
      agentId,
      violations: result.violations,
      attempt,
      maxRetries,
      action: 'regenerate',
    });

    return {
      success: false,
      attempt,
      maxRetries,
      blocked: false,
      violations: result.violations,
    };
  }

  /**
   * Get all immutable system guardrails.
   */
  async getSystemGuardrails(): Promise<Guardrail[]> {
    return this.guardrailRepository.find({
      where: { type: 'system' },
      order: { name: 'ASC' },
    });
  }

  /**
   * Get all tenant-specific guardrails.
   */
  async getTenantGuardrails(tenantId: string): Promise<Guardrail[]> {
    return this.guardrailRepository.find({
      where: { tenantId, type: 'tenant' },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Create a new tenant-specific guardrail.
   */
  async createTenantGuardrail(
    tenantId: string,
    dto: CreateGuardrailDto,
  ): Promise<Guardrail> {
    const rule: GuardrailRule = {
      pattern: dto.pattern,
      classifier: dto.classifier,
      categories: dto.categories,
      action: dto.action,
      maxRetries: dto.maxRetries ?? 3,
    };

    const guardrail = this.guardrailRepository.create({
      tenantId,
      type: 'tenant',
      name: dto.name,
      description: dto.description,
      rule,
      version: 1,
      isActive: true,
    });

    const saved = await this.guardrailRepository.save(guardrail);

    // Save initial version for rollback
    await this.saveVersion(saved, null);

    // Invalidate distributed cache so new guardrail applies immediately
    await this.cache.delete(
      this.keyBuilder.tenantKey(tenantId, 'guardrails', 'active'),
    );

    this.eventEmitter.emit('guardrails.created', {
      tenantId,
      guardrailId: saved.id,
    });

    this.logger.log(
      `Created tenant guardrail "${dto.name}" for tenant ${tenantId}`,
    );
    return saved;
  }

  /**
   * Update an existing tenant guardrail. System guardrails cannot be updated.
   */
  async updateTenantGuardrail(
    guardrailId: string,
    dto: UpdateGuardrailDto,
    userId?: string,
  ): Promise<Guardrail> {
    const guardrail = await this.findGuardrailOrFail(guardrailId);

    if (guardrail.type === 'system') {
      throw new ForbiddenException(
        'System guardrails are immutable and cannot be modified',
      );
    }

    // Save current state as a version before updating
    await this.saveVersion(guardrail, userId ?? null);

    // Apply updates
    if (dto.name !== undefined) guardrail.name = dto.name;
    if (dto.description !== undefined) guardrail.description = dto.description;
    if (dto.isActive !== undefined) guardrail.isActive = dto.isActive;

    // Update rule fields
    const updatedRule = { ...guardrail.rule };
    if (dto.pattern !== undefined) updatedRule.pattern = dto.pattern;
    if (dto.classifier !== undefined) updatedRule.classifier = dto.classifier;
    if (dto.categories !== undefined) updatedRule.categories = dto.categories;
    if (dto.action !== undefined) updatedRule.action = dto.action;
    if (dto.maxRetries !== undefined) updatedRule.maxRetries = dto.maxRetries;
    guardrail.rule = updatedRule;

    // Increment version
    guardrail.version += 1;

    const saved = await this.guardrailRepository.save(guardrail);

    // Invalidate distributed cache so updated guardrail applies immediately
    await this.cache.delete(
      this.keyBuilder.tenantKey(guardrail.tenantId!, 'guardrails', 'active'),
    );

    this.eventEmitter.emit('guardrails.updated', {
      tenantId: guardrail.tenantId,
      guardrailId: saved.id,
      version: saved.version,
    });

    this.logger.log(
      `Updated guardrail "${saved.name}" to version ${saved.version}`,
    );
    return saved;
  }

  /**
   * Rollback a tenant guardrail to a previous version.
   * System guardrails cannot be rolled back.
   */
  async rollback(guardrailId: string, version: number): Promise<Guardrail> {
    const guardrail = await this.findGuardrailOrFail(guardrailId);

    if (guardrail.type === 'system') {
      throw new ForbiddenException(
        'System guardrails are immutable and cannot be rolled back',
      );
    }

    const targetVersion = await this.versionRepository.findOne({
      where: { guardrailId, version },
    });

    if (!targetVersion) {
      throw new NotFoundException(
        `Version ${version} not found for guardrail ${guardrailId}`,
      );
    }

    // Save current state before rollback
    await this.saveVersion(guardrail, null);

    // Restore from version snapshot
    guardrail.name = targetVersion.name;
    guardrail.description = targetVersion.description;
    guardrail.rule = targetVersion.rule;
    guardrail.isActive = targetVersion.isActive;
    guardrail.version += 1;

    const saved = await this.guardrailRepository.save(guardrail);

    // Invalidate distributed cache
    await this.cache.delete(
      this.keyBuilder.tenantKey(guardrail.tenantId!, 'guardrails', 'active'),
    );

    this.logger.log(
      `Rolled back guardrail "${saved.name}" to version ${version} (new version: ${saved.version})`,
    );
    return saved;
  }

  /**
   * Delete a tenant guardrail. System guardrails cannot be deleted.
   */
  async deleteTenantGuardrail(guardrailId: string): Promise<void> {
    const guardrail = await this.findGuardrailOrFail(guardrailId);

    if (guardrail.type === 'system') {
      throw new ForbiddenException(
        'System guardrails are immutable and cannot be deleted',
      );
    }

    await this.guardrailRepository.remove(guardrail);

    // Invalidate distributed cache
    await this.cache.delete(
      this.keyBuilder.tenantKey(guardrail.tenantId!, 'guardrails', 'active'),
    );

    this.logger.log(`Deleted guardrail "${guardrail.name}"`);
  }

  /**
   * Get violation report for admin: frequency, top agents, trends.
   */
  async getViolationReport(
    tenantId: string,
    period: DateRange,
  ): Promise<ViolationReport> {
    const violations = await this.violationRepository
      .createQueryBuilder('v')
      .where('v.tenant_id = :tenantId', { tenantId })
      .andWhere('v.created_at >= :start', { start: period.start })
      .andWhere('v.created_at <= :end', { end: period.end })
      .getMany();

    // Aggregate by guardrail
    const byGuardrailMap = new Map<
      string,
      { guardrailId: string; guardrailName: string; count: number }
    >();
    for (const v of violations) {
      const existing = byGuardrailMap.get(v.guardrailId);
      if (existing) {
        existing.count++;
      } else {
        byGuardrailMap.set(v.guardrailId, {
          guardrailId: v.guardrailId,
          guardrailName: v.guardrailName,
          count: 1,
        });
      }
    }

    // Aggregate by agent
    const byAgentMap = new Map<string, { agentId: string; count: number }>();
    for (const v of violations) {
      if (!v.agentId) continue;
      const existing = byAgentMap.get(v.agentId);
      if (existing) {
        existing.count++;
      } else {
        byAgentMap.set(v.agentId, { agentId: v.agentId, count: 1 });
      }
    }

    // Aggregate daily trends
    const trendsMap = new Map<string, number>();
    for (const v of violations) {
      const date = v.createdAt.toISOString().split('T')[0];
      trendsMap.set(date, (trendsMap.get(date) || 0) + 1);
    }

    const trends = Array.from(trendsMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      tenantId,
      period,
      totalViolations: violations.length,
      byGuardrail: Array.from(byGuardrailMap.values()).sort(
        (a, b) => b.count - a.count,
      ),
      byAgent: Array.from(byAgentMap.values()).sort(
        (a, b) => b.count - a.count,
      ),
      trends,
    };
  }

  /**
   * Seed system guardrails into the database if they don't exist.
   * Called during module initialization.
   */
  async seedSystemGuardrails(): Promise<void> {
    for (const def of SYSTEM_GUARDRAILS_DEFINITIONS) {
      const existing = await this.guardrailRepository.findOne({
        where: { name: def.name, type: 'system' },
      });

      if (!existing) {
        const guardrail = this.guardrailRepository.create({
          tenantId: null,
          type: 'system',
          name: def.name,
          description: def.description,
          rule: def.rule,
          version: 1,
          isActive: true,
        });
        await this.guardrailRepository.save(guardrail);
        this.logger.log(`Seeded system guardrail: ${def.name}`);
      }
    }
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  /**
   * Get all active guardrails (system + tenant) with distributed cache.
   * Implements cache-aside pattern: check cache → on miss, query DB and populate cache.
   */
  private async getActiveGuardrails(tenantId: string): Promise<Guardrail[]> {
    // 1. Try tenant cache (combined system + tenant guardrails)
    const tenantCacheKey = this.keyBuilder.tenantKey(
      tenantId,
      'guardrails',
      'active',
    );
    const cachedTenant = await this.cache.get<Guardrail[]>(tenantCacheKey);
    if (cachedTenant) {
      return cachedTenant;
    }

    // 2. Cache miss — fetch system guardrails (try system cache first)
    const systemCacheKey = this.keyBuilder.globalKey('guardrails', 'system');
    let systemGuardrails = await this.cache.get<Guardrail[]>(systemCacheKey);
    if (!systemGuardrails) {
      // System cache miss — fetch from DB and populate
      systemGuardrails = await this.guardrailRepository.find({
        where: { type: 'system', isActive: true },
      });
      await this.cache.set(systemCacheKey, systemGuardrails, GUARDRAILS_SYSTEM_TTL);
    }

    // 3. Fetch tenant guardrails from DB
    const tenantGuardrails = await this.guardrailRepository.find({
      where: { tenantId, type: 'tenant', isActive: true },
    });

    // 4. Combine and cache
    const all = [...systemGuardrails, ...tenantGuardrails];
    await this.cache.set(tenantCacheKey, all, GUARDRAILS_TENANT_TTL);

    return all;
  }

  /**
   * Check content against a single guardrail using its rule pattern.
   */
  private checkGuardrail(content: string, guardrail: Guardrail): Violation | null {
    const { rule } = guardrail;

    if (!rule.pattern) {
      return null;
    }

    try {
      const regex = new RegExp(rule.pattern, 'i');
      const match = regex.exec(content);

      if (match) {
        return {
          guardrailId: guardrail.id,
          guardrailName: guardrail.name,
          severity: this.determineSeverity(rule),
          description: guardrail.description,
          matchedContent: match[0],
        };
      }
    } catch (error) {
      this.logger.warn(
        `Invalid regex pattern in guardrail "${guardrail.name}": ${rule.pattern}`,
      );
    }

    return null;
  }

  /**
   * Determine severity based on the guardrail rule's action.
   */
  private determineSeverity(rule: GuardrailRule): 'critical' | 'high' | 'medium' {
    switch (rule.action) {
      case 'block':
        return 'critical';
      case 'regenerate':
        return 'high';
      case 'warn':
        return 'medium';
      default:
        return 'medium';
    }
  }

  /**
   * Log violations to the database.
   */
  private async logViolations(
    tenantId: string,
    content: string,
    violations: Violation[],
    agentId?: string,
  ): Promise<void> {
    const entries = violations.map((v) =>
      this.violationRepository.create({
        tenantId,
        guardrailId: v.guardrailId,
        guardrailName: v.guardrailName,
        agentId: agentId ?? null,
        originalContent: content,
        matchedContent: v.matchedContent,
        severity: v.severity,
        actionTaken: 'warned',
        attempt: 1,
      }),
    );

    await this.violationRepository.save(entries);
  }

  /**
   * Log a specific violation action (blocked/regenerated).
   */
  private async logViolationAction(
    tenantId: string,
    content: string,
    violations: Violation[],
    agentId: string | undefined,
    action: 'blocked' | 'regenerated',
    attempt: number,
  ): Promise<void> {
    const entries = violations.map((v) =>
      this.violationRepository.create({
        tenantId,
        guardrailId: v.guardrailId,
        guardrailName: v.guardrailName,
        agentId: agentId ?? null,
        originalContent: content,
        matchedContent: v.matchedContent,
        severity: v.severity,
        actionTaken: action,
        attempt,
      }),
    );

    await this.violationRepository.save(entries);
  }

  /**
   * Get max retries from a specific guardrail.
   */
  private async getMaxRetries(guardrailId: string | undefined): Promise<number> {
    if (!guardrailId) return 3;

    const guardrail = await this.guardrailRepository.findOne({
      where: { id: guardrailId },
    });

    return guardrail?.rule?.maxRetries ?? 3;
  }

  /**
   * Save a version snapshot of a guardrail for rollback.
   */
  private async saveVersion(
    guardrail: Guardrail,
    changedBy: string | null,
  ): Promise<void> {
    const versionEntry = this.versionRepository.create({
      guardrailId: guardrail.id,
      version: guardrail.version,
      name: guardrail.name,
      description: guardrail.description,
      rule: guardrail.rule,
      isActive: guardrail.isActive,
      changedBy,
    });

    await this.versionRepository.save(versionEntry);
  }

  /**
   * Find a guardrail by ID or throw NotFoundException.
   */
  private async findGuardrailOrFail(guardrailId: string): Promise<Guardrail> {
    const guardrail = await this.guardrailRepository.findOne({
      where: { id: guardrailId },
    });
    if (!guardrail) {
      throw new NotFoundException(`Guardrail not found: ${guardrailId}`);
    }
    return guardrail;
  }
}
