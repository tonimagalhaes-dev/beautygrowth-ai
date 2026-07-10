import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Prompt } from '../entities/prompt.entity';
import { PromptVersion } from '../entities/prompt-version.entity';
import { CreatePromptDto } from '../dto/create-prompt.dto';
import { UpdatePromptDto } from '../dto/update-prompt.dto';
import {
  IPromptRegistryService,
  ResolvedPrompt,
  SandboxResult,
} from '../interfaces/prompt-registry-service.interface';
import { ICacheService } from '../../cache/interfaces/cache-service.interface';
import { CacheKeyBuilder } from '../../cache/services/cache-key-builder.service';
import { CACHE_SERVICE, PROMPTS_TTL } from '../../cache/config/cache.constants';

/**
 * Regex pattern for detecting template variables like {{variable_name}}.
 */
const VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

/**
 * Regex pattern for validating semantic versions (major.minor.patch).
 */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

@Injectable()
export class PromptRegistryService implements IPromptRegistryService {
  private readonly logger = new Logger(PromptRegistryService.name);

  constructor(
    @InjectRepository(Prompt)
    private readonly promptRepository: Repository<Prompt>,
    @InjectRepository(PromptVersion)
    private readonly versionRepository: Repository<PromptVersion>,
    @Inject(CACHE_SERVICE) private readonly cache: ICacheService,
    private readonly keyBuilder: CacheKeyBuilder,
  ) {}

  /**
   * Create a new prompt with its initial version.
   */
  async create(dto: CreatePromptDto, authorId: string | null): Promise<Prompt> {
    this.validateSemver(dto.version);

    const variables = this.extractVariables(dto.content);

    // Create the prompt
    const prompt = this.promptRepository.create({
      agentType: dto.agentType,
      function: dto.function,
      activeVersion: dto.version,
    });

    const savedPrompt = await this.promptRepository.save(prompt);

    // Create the initial version
    const version = this.versionRepository.create({
      promptId: savedPrompt.id,
      version: dto.version,
      content: dto.content,
      variables,
      author: authorId,
      description: dto.description || '',
      isActive: true,
    });

    await this.versionRepository.save(version);

    this.logger.log(`Created prompt ${savedPrompt.id} v${dto.version}`);
    return savedPrompt;
  }

  /**
   * Update a prompt by creating a new version. The new version becomes the active version.
   */
  async update(
    promptId: string,
    dto: UpdatePromptDto,
    authorId: string | null,
  ): Promise<PromptVersion> {
    this.validateSemver(dto.version);

    const prompt = await this.findPromptOrFail(promptId);

    // Check version doesn't already exist for this prompt
    const existingVersion = await this.versionRepository.findOne({
      where: { promptId, version: dto.version },
    });
    if (existingVersion) {
      throw new BadRequestException(
        `Version ${dto.version} already exists for prompt ${promptId}`,
      );
    }

    // Validate new version is greater than current active
    if (prompt.activeVersion && !this.isVersionGreater(dto.version, prompt.activeVersion)) {
      throw new BadRequestException(
        `New version ${dto.version} must be greater than current active version ${prompt.activeVersion}`,
      );
    }

    const variables = this.extractVariables(dto.content);

    // Deactivate current active version
    await this.versionRepository.update(
      { promptId, isActive: true },
      { isActive: false },
    );

    // Create new version as active
    const newVersion = this.versionRepository.create({
      promptId,
      version: dto.version,
      content: dto.content,
      variables,
      author: authorId,
      description: dto.description || '',
      isActive: true,
    });

    const savedVersion = await this.versionRepository.save(newVersion);

    // Update prompt active version reference
    prompt.activeVersion = dto.version;
    await this.promptRepository.save(prompt);

    // Invalidate distributed cache so updated prompt applies immediately
    await this.cache.delete(
      this.keyBuilder.globalKey('prompts', `${promptId}:active`),
    );

    this.logger.log(`Updated prompt ${promptId} to v${dto.version}`);
    return savedVersion;
  }

  /**
   * Get the active version of a prompt with its raw content (no variable substitution).
   * Implements cache-aside pattern: check cache → on miss, query DB and populate cache.
   */
  async getActive(promptId: string): Promise<ResolvedPrompt> {
    const cacheKey = this.keyBuilder.globalKey('prompts', `${promptId}:active`);

    // Try cache first
    const cached = await this.cache.get<ResolvedPrompt>(cacheKey);
    if (cached) {
      return cached;
    }

    // Cache miss — fetch from DB
    const prompt = await this.findPromptOrFail(promptId);

    const activeVersion = await this.versionRepository.findOne({
      where: { promptId, isActive: true },
    });

    if (!activeVersion) {
      throw new NotFoundException(
        `No active version found for prompt ${promptId}`,
      );
    }

    const result: ResolvedPrompt = {
      content: activeVersion.content,
      version: activeVersion.version,
      resolvedVariables: {},
      unresolvedVariables: activeVersion.variables,
    };

    // Cache the template (with unresolved variables)
    await this.cache.set(cacheKey, result, PROMPTS_TTL);

    return result;
  }

  /**
   * Rollback to any previous version. Deactivates current version,
   * activates the target version.
   */
  async rollback(promptId: string, version: string): Promise<void> {
    const prompt = await this.findPromptOrFail(promptId);

    const targetVersion = await this.versionRepository.findOne({
      where: { promptId, version },
    });

    if (!targetVersion) {
      throw new NotFoundException(
        `Version ${version} not found for prompt ${promptId}`,
      );
    }

    // Deactivate all versions for this prompt
    await this.versionRepository.update(
      { promptId },
      { isActive: false },
    );

    // Activate target version
    targetVersion.isActive = true;
    await this.versionRepository.save(targetVersion);

    // Update prompt active version reference
    prompt.activeVersion = version;
    await this.promptRepository.save(prompt);

    // Invalidate distributed cache so rolled-back prompt applies immediately
    await this.cache.delete(
      this.keyBuilder.globalKey('prompts', `${promptId}:active`),
    );

    this.logger.log(`Rolled back prompt ${promptId} to v${version}`);
  }

  /**
   * Resolve a prompt's active version with tenant context variables.
   * Reports any unresolved variables.
   */
  async resolve(
    promptId: string,
    tenantContext: Record<string, string>,
  ): Promise<ResolvedPrompt> {
    const prompt = await this.findPromptOrFail(promptId);

    const activeVersion = await this.versionRepository.findOne({
      where: { promptId, isActive: true },
    });

    if (!activeVersion) {
      throw new NotFoundException(
        `No active version found for prompt ${promptId}`,
      );
    }

    return this.resolveTemplate(activeVersion, tenantContext);
  }

  /**
   * Test a specific version in sandbox mode — resolves the template without affecting production.
   */
  async testInSandbox(
    promptId: string,
    version: string,
    context: Record<string, string>,
  ): Promise<SandboxResult> {
    await this.findPromptOrFail(promptId);

    const targetVersion = await this.versionRepository.findOne({
      where: { promptId, version },
    });

    if (!targetVersion) {
      throw new NotFoundException(
        `Version ${version} not found for prompt ${promptId}`,
      );
    }

    const resolved = this.resolveTemplate(targetVersion, context);

    return {
      resolvedContent: resolved.content,
      version: resolved.version,
      resolvedVariables: resolved.resolvedVariables,
      unresolvedVariables: resolved.unresolvedVariables,
      isProduction: false,
    };
  }

  /**
   * List all versions of a prompt, ordered by creation date (most recent first).
   */
  async listVersions(promptId: string): Promise<PromptVersion[]> {
    await this.findPromptOrFail(promptId);

    return this.versionRepository.find({
      where: { promptId },
      order: { createdAt: 'DESC' },
    });
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private async findPromptOrFail(promptId: string): Promise<Prompt> {
    const prompt = await this.promptRepository.findOne({
      where: { id: promptId },
    });
    if (!prompt) {
      throw new NotFoundException(`Prompt not found: ${promptId}`);
    }
    return prompt;
  }

  /**
   * Extract {{variable_name}} patterns from content.
   */
  extractVariables(content: string): string[] {
    const matches = new Set<string>();
    let match: RegExpExecArray | null;
    const regex = new RegExp(VARIABLE_PATTERN.source, VARIABLE_PATTERN.flags);

    while ((match = regex.exec(content)) !== null) {
      matches.add(match[1]);
    }

    return Array.from(matches);
  }

  /**
   * Resolve template variables in content using the provided context.
   * Returns resolved content, resolved variables map, and list of unresolved variables.
   */
  resolveTemplate(
    version: PromptVersion,
    context: Record<string, string>,
  ): ResolvedPrompt {
    const resolvedVariables: Record<string, string> = {};
    const unresolvedVariables: string[] = [];

    let resolvedContent = version.content;

    for (const variable of version.variables) {
      if (context[variable] !== undefined && context[variable] !== null) {
        resolvedVariables[variable] = context[variable];
        resolvedContent = resolvedContent.replace(
          new RegExp(`\\{\\{${variable}\\}\\}`, 'g'),
          () => context[variable],
        );
      } else {
        unresolvedVariables.push(variable);
      }
    }

    return {
      content: resolvedContent,
      version: version.version,
      resolvedVariables,
      unresolvedVariables,
    };
  }

  /**
   * Validate that a version string follows semantic versioning (major.minor.patch).
   */
  private validateSemver(version: string): void {
    if (!SEMVER_PATTERN.test(version)) {
      throw new BadRequestException(
        `Invalid version format: "${version}". Expected semantic versioning (major.minor.patch)`,
      );
    }
  }

  /**
   * Compare two semver strings. Returns true if versionA > versionB.
   */
  private isVersionGreater(versionA: string, versionB: string): boolean {
    const [aMajor, aMinor, aPatch] = versionA.split('.').map(Number);
    const [bMajor, bMinor, bPatch] = versionB.split('.').map(Number);

    if (aMajor !== bMajor) return aMajor > bMajor;
    if (aMinor !== bMinor) return aMinor > bMinor;
    return aPatch > bPatch;
  }
}
