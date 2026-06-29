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
} from '@nestjs/common';
import { PromptRegistryService } from './services/prompt-registry.service';
import { CreatePromptDto } from './dto/create-prompt.dto';
import { UpdatePromptDto } from './dto/update-prompt.dto';
import { TestSandboxDto } from './dto/test-sandbox.dto';
import { Prompt, PromptVersion } from './entities';
import { ResolvedPrompt, SandboxResult } from './interfaces';
import { CurrentTenant } from '@shared/decorators';
import { TenantContext } from '@shared/interfaces';

@Controller('prompts')
export class PromptRegistryController {
  constructor(private readonly promptRegistryService: PromptRegistryService) {}

  /**
   * POST /prompts
   * Create a new prompt with initial version.
   */
  @Post()
  async create(
    @Body() dto: CreatePromptDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<Prompt> {
    return this.promptRegistryService.create(dto, tenant.userId);
  }

  /**
   * PATCH /prompts/:id
   * Update a prompt by creating a new version.
   */
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromptDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<PromptVersion> {
    return this.promptRegistryService.update(id, dto, tenant.userId);
  }

  /**
   * GET /prompts/:id/active
   * Get the active version of a prompt (raw, without resolution).
   */
  @Get(':id/active')
  async getActive(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResolvedPrompt> {
    return this.promptRegistryService.getActive(id);
  }

  /**
   * POST /prompts/:id/rollback
   * Rollback to a specific version.
   */
  @Post(':id/rollback')
  @HttpCode(HttpStatus.NO_CONTENT)
  async rollback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('version') version: string,
  ): Promise<void> {
    return this.promptRegistryService.rollback(id, version);
  }

  /**
   * POST /prompts/:id/resolve
   * Resolve a prompt's active version with tenant context variables.
   */
  @Post(':id/resolve')
  async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('context') context: Record<string, string>,
  ): Promise<ResolvedPrompt> {
    return this.promptRegistryService.resolve(id, context || {});
  }

  /**
   * POST /prompts/:id/sandbox
   * Test a specific version with test context without affecting production.
   */
  @Post(':id/sandbox')
  async testInSandbox(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TestSandboxDto,
  ): Promise<SandboxResult> {
    return this.promptRegistryService.testInSandbox(id, dto.version, dto.context);
  }

  /**
   * GET /prompts/:id/versions
   * List all versions of a prompt.
   */
  @Get(':id/versions')
  async listVersions(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PromptVersion[]> {
    return this.promptRegistryService.listVersions(id);
  }
}
