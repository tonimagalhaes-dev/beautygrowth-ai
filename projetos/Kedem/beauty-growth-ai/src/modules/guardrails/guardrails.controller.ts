import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { GuardrailsService } from './services/guardrails.service';
import { CreateGuardrailDto } from './dto/create-guardrail.dto';
import { UpdateGuardrailDto } from './dto/update-guardrail.dto';
import { ValidateContentDto } from './dto/validate-content.dto';
import { Guardrail } from './entities/guardrail.entity';
import {
  ValidationResult,
  ViolationReport,
  RegenerationResult,
} from './interfaces/guardrails-service.interface';
import { CurrentTenant } from '@shared/decorators';
import { TenantContext } from '@shared/interfaces';

@Controller('guardrails')
export class GuardrailsController {
  constructor(private readonly guardrailsService: GuardrailsService) {}

  /**
   * POST /guardrails/validate
   * Validate content against all applicable guardrails (system + tenant).
   */
  @Post('validate')
  async validate(
    @Body() dto: ValidateContentDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<ValidationResult> {
    return this.guardrailsService.validate(
      dto.content,
      tenant.tenantId,
      dto.agentId,
    );
  }

  /**
   * POST /guardrails/validate-with-regeneration
   * Validate content with regeneration logic (tracks retries, blocks after max).
   */
  @Post('validate-with-regeneration')
  async validateWithRegeneration(
    @Body() dto: ValidateContentDto & { attempt?: number },
    @CurrentTenant() tenant: TenantContext,
  ): Promise<RegenerationResult> {
    return this.guardrailsService.validateWithRegeneration(
      dto.content,
      tenant.tenantId,
      dto.agentId,
      dto.attempt ?? 1,
    );
  }

  /**
   * GET /guardrails/system
   * List all immutable system guardrails.
   */
  @Get('system')
  async getSystemGuardrails(): Promise<Guardrail[]> {
    return this.guardrailsService.getSystemGuardrails();
  }

  /**
   * GET /guardrails/tenant
   * List all custom guardrails for the current tenant.
   */
  @Get('tenant')
  async getTenantGuardrails(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<Guardrail[]> {
    return this.guardrailsService.getTenantGuardrails(tenant.tenantId);
  }

  /**
   * POST /guardrails/tenant
   * Create a new tenant-specific guardrail.
   */
  @Post('tenant')
  async createTenantGuardrail(
    @Body() dto: CreateGuardrailDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<Guardrail> {
    return this.guardrailsService.createTenantGuardrail(tenant.tenantId, dto);
  }

  /**
   * PATCH /guardrails/tenant/:id
   * Update a tenant-specific guardrail.
   */
  @Patch('tenant/:id')
  async updateTenantGuardrail(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGuardrailDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<Guardrail> {
    return this.guardrailsService.updateTenantGuardrail(id, dto, tenant.userId);
  }

  /**
   * POST /guardrails/tenant/:id/rollback
   * Rollback a guardrail to a specific version.
   */
  @Post('tenant/:id/rollback')
  async rollback(
    @Param('id', ParseUUIDPipe) id: string,
    @Body('version', ParseIntPipe) version: number,
  ): Promise<Guardrail> {
    return this.guardrailsService.rollback(id, version);
  }

  /**
   * DELETE /guardrails/tenant/:id
   * Delete a tenant-specific guardrail.
   */
  @Delete('tenant/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTenantGuardrail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.guardrailsService.deleteTenantGuardrail(id);
  }

  /**
   * GET /guardrails/violations/report
   * Get violation report for admin dashboard.
   */
  @Get('violations/report')
  async getViolationReport(
    @CurrentTenant() tenant: TenantContext,
    @Query('start') start: string,
    @Query('end') end: string,
  ): Promise<ViolationReport> {
    return this.guardrailsService.getViolationReport(tenant.tenantId, {
      start: new Date(start),
      end: new Date(end),
    });
  }
}
