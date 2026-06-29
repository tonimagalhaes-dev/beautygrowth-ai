import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PrivacyService } from './services/privacy.service';
import { RecordConsentDto } from './dto/record-consent.dto';
import { UpdateRetentionPolicyDto } from './dto/update-retention-policy.dto';
import { ExportDataDto } from './dto/export-data.dto';
import { AnonymizeDto } from './dto/anonymize.dto';
import { DeletionRequestDto } from './dto/deletion-request.dto';
import { UpdateDPOContactDto } from './dto/update-dpo-contact.dto';
import { CreateROPARecordDto } from './dto/create-ropa-record.dto';
import { CurrentTenant } from '@shared/decorators';
import { TenantContext } from '@shared/interfaces';
import {
  ConsentRecord,
  DeletionResult,
  DataExport,
  RetentionPolicy,
  ROPARecord,
  DPOContact,
} from './interfaces/privacy-service.interface';

@Controller('privacy')
export class PrivacyController {
  constructor(private readonly privacyService: PrivacyService) {}

  // =========================================================================
  // CONSENT ENDPOINTS
  // =========================================================================

  /**
   * POST /privacy/consent
   * Record explicit consent for a data subject.
   */
  @Post('consent')
  async recordConsent(
    @Body() dto: RecordConsentDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<ConsentRecord> {
    return this.privacyService.recordConsent({
      tenantId: tenant.tenantId,
      subjectId: dto.subjectId,
      purpose: dto.purpose,
      collectionMethod: dto.collectionMethod,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
    });
  }

  /**
   * POST /privacy/consent/:id/revoke
   * Revoke a previously granted consent.
   */
  @Post('consent/:id/revoke')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeConsent(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.privacyService.revokeConsent(id);
  }

  /**
   * GET /privacy/consent/check
   * Check if active consent exists for a subject+purpose.
   */
  @Get('consent/check')
  async checkConsent(
    @Query('subjectId') subjectId: string,
    @Query('purpose') purpose: string,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<{ allowed: boolean }> {
    const allowed = await this.privacyService.checkConsent(
      subjectId,
      purpose,
      tenant.tenantId,
    );
    return { allowed };
  }

  // =========================================================================
  // DELETION ENDPOINTS
  // =========================================================================

  /**
   * POST /privacy/deletion
   * Submit a data deletion request (right to erasure).
   */
  @Post('deletion')
  async requestDeletion(
    @Body() dto: DeletionRequestDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<DeletionResult> {
    return this.privacyService.handleDeletionRequest(
      dto.subjectId,
      tenant.tenantId,
    );
  }

  // =========================================================================
  // DATA EXPORT ENDPOINTS
  // =========================================================================

  /**
   * POST /privacy/export
   * Export all personal data for a subject (portability).
   */
  @Post('export')
  async exportData(
    @Body() dto: ExportDataDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<DataExport> {
    return this.privacyService.exportData(
      dto.subjectId,
      tenant.tenantId,
      dto.format,
    );
  }

  // =========================================================================
  // ANONYMIZATION ENDPOINTS
  // =========================================================================

  /**
   * POST /privacy/anonymize
   * Anonymize personal data for a subject (irreversible).
   */
  @Post('anonymize')
  @HttpCode(HttpStatus.NO_CONTENT)
  async anonymize(
    @Body() dto: AnonymizeDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<void> {
    return this.privacyService.anonymize(
      dto.subjectId,
      tenant.tenantId,
      dto.scope,
    );
  }

  // =========================================================================
  // RETENTION POLICY ENDPOINTS
  // =========================================================================

  /**
   * GET /privacy/retention-policy
   * Get retention policy for the current tenant.
   */
  @Get('retention-policy')
  async getRetentionPolicy(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<RetentionPolicy> {
    return this.privacyService.getRetentionPolicy(tenant.tenantId);
  }

  /**
   * PATCH /privacy/retention-policy
   * Update retention policy for the current tenant.
   */
  @Patch('retention-policy')
  async updateRetentionPolicy(
    @Body() dto: UpdateRetentionPolicyDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<RetentionPolicy> {
    return this.privacyService.updateRetentionPolicy(tenant.tenantId, dto);
  }

  // =========================================================================
  // ROPA ENDPOINTS
  // =========================================================================

  /**
   * GET /privacy/ropa
   * Get all ROPA records for the current tenant.
   */
  @Get('ropa')
  async getROPA(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<ROPARecord[]> {
    return this.privacyService.getROPA(tenant.tenantId);
  }

  /**
   * POST /privacy/ropa
   * Create a new ROPA record.
   */
  @Post('ropa')
  async createROPARecord(
    @Body() dto: CreateROPARecordDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<ROPARecord> {
    return this.privacyService.createROPARecord(tenant.tenantId, dto);
  }

  // =========================================================================
  // DPO CONTACT ENDPOINTS
  // =========================================================================

  /**
   * GET /privacy/dpo-contact
   * Get DPO contact information for the current tenant.
   */
  @Get('dpo-contact')
  async getDPOContact(
    @CurrentTenant() tenant: TenantContext,
  ): Promise<DPOContact> {
    return this.privacyService.getDPOContact(tenant.tenantId);
  }

  /**
   * PATCH /privacy/dpo-contact
   * Create or update DPO contact for the current tenant.
   */
  @Patch('dpo-contact')
  async updateDPOContact(
    @Body() dto: UpdateDPOContactDto,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<DPOContact> {
    return this.privacyService.updateDPOContact(tenant.tenantId, dto);
  }

  // =========================================================================
  // PROCESSING GATE ENDPOINTS
  // =========================================================================

  /**
   * GET /privacy/processing-allowed
   * Check if processing is allowed for a subject+purpose (consent-gated).
   */
  @Get('processing-allowed')
  async isProcessingAllowed(
    @Query('subjectId') subjectId: string,
    @Query('purpose') purpose: string,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<{ allowed: boolean }> {
    const allowed = await this.privacyService.isProcessingAllowed(
      subjectId,
      purpose,
      tenant.tenantId,
    );
    return { allowed };
  }
}
