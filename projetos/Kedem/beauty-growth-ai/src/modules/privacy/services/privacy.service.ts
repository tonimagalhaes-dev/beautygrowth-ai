import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';

import { Consent } from '../entities/consent.entity';
import { RetentionPolicyEntity } from '../entities/retention-policy.entity';
import { DeletionRequest } from '../entities/deletion-request.entity';
import { ROPARecordEntity } from '../entities/ropa-record.entity';
import { DPOContactEntity } from '../entities/dpo-contact.entity';
import {
  IPrivacyService,
  ConsentDto,
  ConsentRecord,
  DeletionResult,
  DataExport,
  ExportFormat,
  RetentionPolicy,
  UpdateRetentionDto,
  AnonymizationScope,
  ROPARecord,
  DPOContact,
  UpdateDPOContactDto,
} from '../interfaces/privacy-service.interface';

/** Number of calendar days for deletion/export deadline (LGPD). */
const DEADLINE_DAYS = 15;

@Injectable()
export class PrivacyService implements IPrivacyService {
  private readonly logger = new Logger(PrivacyService.name);

  constructor(
    @InjectRepository(Consent)
    private readonly consentRepository: Repository<Consent>,
    @InjectRepository(RetentionPolicyEntity)
    private readonly retentionRepository: Repository<RetentionPolicyEntity>,
    @InjectRepository(DeletionRequest)
    private readonly deletionRepository: Repository<DeletionRequest>,
    @InjectRepository(ROPARecordEntity)
    private readonly ropaRepository: Repository<ROPARecordEntity>,
    @InjectRepository(DPOContactEntity)
    private readonly dpoRepository: Repository<DPOContactEntity>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // =========================================================================
  // CONSENT MANAGEMENT
  // =========================================================================

  /**
   * Record explicit consent for a data subject and purpose.
   * Requirement 12.1: Collect/manage explicit consent before any processing.
   */
  async recordConsent(dto: ConsentDto): Promise<ConsentRecord> {
    const consent = this.consentRepository.create({
      tenantId: dto.tenantId,
      subjectId: dto.subjectId,
      purpose: dto.purpose,
      collectionMethod: dto.collectionMethod,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
      status: 'active',
    });

    const saved = await this.consentRepository.save(consent);

    this.eventEmitter.emit('privacy.consent.recorded', {
      tenantId: dto.tenantId,
      subjectId: dto.subjectId,
      purpose: dto.purpose,
      consentId: saved.id,
    });

    this.logger.log(
      `Consent recorded for subject ${dto.subjectId}, purpose: ${dto.purpose}`,
    );

    return this.toConsentRecord(saved);
  }

  /**
   * Revoke a previously granted consent.
   * Sets status to 'revoked' and records the revocation timestamp.
   */
  async revokeConsent(consentId: string): Promise<void> {
    const consent = await this.consentRepository.findOne({
      where: { id: consentId },
    });

    if (!consent) {
      throw new NotFoundException(`Consent not found: ${consentId}`);
    }

    if (consent.status === 'revoked') {
      return; // Already revoked, idempotent
    }

    consent.status = 'revoked';
    consent.revokedAt = new Date();
    await this.consentRepository.save(consent);

    this.eventEmitter.emit('privacy.consent.revoked', {
      tenantId: consent.tenantId,
      subjectId: consent.subjectId,
      purpose: consent.purpose,
      consentId: consent.id,
    });

    this.logger.log(
      `Consent revoked: ${consentId} (subject: ${consent.subjectId}, purpose: ${consent.purpose})`,
    );
  }

  /**
   * Check if active consent exists for a subject+purpose combination.
   * Requirement 12.8: Consent-gated processing.
   * Returns true only if there is an active, non-expired consent.
   */
  async checkConsent(
    subjectId: string,
    purpose: string,
    tenantId: string,
  ): Promise<boolean> {
    const consent = await this.consentRepository.findOne({
      where: {
        tenantId,
        subjectId,
        purpose,
        status: 'active',
      },
      order: { grantedAt: 'DESC' },
    });

    if (!consent) {
      return false;
    }

    // Check if consent has expired
    if (consent.expiresAt && new Date() > consent.expiresAt) {
      // Mark as expired
      consent.status = 'expired';
      await this.consentRepository.save(consent);
      return false;
    }

    return true;
  }

  // =========================================================================
  // DATA DELETION (RIGHT TO ERASURE)
  // =========================================================================

  /**
   * Handle a data deletion request (right to erasure).
   * Requirement 12.4: Delete across ALL stores within 15 calendar days.
   */
  async handleDeletionRequest(
    subjectId: string,
    tenantId: string,
  ): Promise<DeletionResult> {
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + DEADLINE_DAYS);

    const deletionRequest = this.deletionRepository.create({
      tenantId,
      subjectId,
      deadline,
      status: 'in_progress',
      deletedFrom: [],
    });

    const saved = await this.deletionRepository.save(deletionRequest);

    // Perform deletion across all stores
    const deletedFrom: string[] = [];

    try {
      // Delete consents
      await this.consentRepository.delete({ tenantId, subjectId });
      deletedFrom.push('consents');

      // Emit event for other modules to delete their data
      this.eventEmitter.emit('privacy.deletion.requested', {
        tenantId,
        subjectId,
        requestId: saved.id,
        deadline,
      });

      deletedFrom.push('events_emitted');

      // Mark as completed
      saved.deletedFrom = deletedFrom;
      saved.status = 'completed';
      saved.completedAt = new Date();
      await this.deletionRepository.save(saved);

      this.logger.log(
        `Deletion request completed for subject ${subjectId} in tenant ${tenantId}`,
      );
    } catch (error) {
      saved.status = 'failed';
      saved.deletedFrom = deletedFrom;
      await this.deletionRepository.save(saved);

      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Deletion request failed for subject ${subjectId}: ${errorMessage}`,
      );
    }

    return this.toDeletionResult(saved);
  }

  // =========================================================================
  // DATA EXPORT (PORTABILITY)
  // =========================================================================

  /**
   * Export all personal data for a subject in the requested format.
   * Requirement 12.5: Data export (portability) in JSON/CSV within 15 days.
   */
  async exportData(
    subjectId: string,
    tenantId: string,
    format: ExportFormat = 'json',
  ): Promise<DataExport> {
    // Gather all personal data for this subject within the tenant
    const consents = await this.consentRepository.find({
      where: { tenantId, subjectId },
    });

    const deletionRequests = await this.deletionRepository.find({
      where: { tenantId, subjectId },
    });

    const data: Record<string, any> = {
      subjectId,
      consents: consents.map((c) => ({
        id: c.id,
        purpose: c.purpose,
        collectionMethod: c.collectionMethod,
        grantedAt: c.grantedAt,
        expiresAt: c.expiresAt,
        revokedAt: c.revokedAt,
        status: c.status,
      })),
      deletionRequests: deletionRequests.map((d) => ({
        id: d.id,
        requestedAt: d.requestedAt,
        status: d.status,
        completedAt: d.completedAt,
      })),
    };

    const generatedAt = new Date();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 48);

    this.eventEmitter.emit('privacy.data.exported', {
      tenantId,
      subjectId,
      format,
      generatedAt,
    });

    this.logger.log(
      `Data exported for subject ${subjectId} in tenant ${tenantId} (format: ${format})`,
    );

    return {
      subjectId,
      tenantId,
      format,
      data,
      generatedAt,
      expiresAt,
    };
  }

  // =========================================================================
  // RETENTION POLICIES
  // =========================================================================

  /**
   * Get retention policy for a tenant. Creates default if none exists.
   * Requirement 12.2: Retention policies configurable per tenant.
   */
  async getRetentionPolicy(tenantId: string): Promise<RetentionPolicy> {
    let policy = await this.retentionRepository.findOne({
      where: { tenantId },
    });

    if (!policy) {
      // Create default retention policy
      policy = this.retentionRepository.create({
        tenantId,
        leadDataMonths: 12,
        financialDataYears: 5,
        auditLogMonths: 12,
        customRules: [],
      });
      policy = await this.retentionRepository.save(policy);
    }

    return this.toRetentionPolicy(policy);
  }

  /**
   * Update retention policy for a tenant.
   * Validates that audit log months is at least 12.
   */
  async updateRetentionPolicy(
    tenantId: string,
    dto: UpdateRetentionDto,
  ): Promise<RetentionPolicy> {
    if (dto.auditLogMonths !== undefined && dto.auditLogMonths < 12) {
      throw new BadRequestException(
        'Audit log retention must be at least 12 months',
      );
    }

    let policy = await this.retentionRepository.findOne({
      where: { tenantId },
    });

    if (!policy) {
      policy = this.retentionRepository.create({
        tenantId,
        leadDataMonths: 12,
        financialDataYears: 5,
        auditLogMonths: 12,
        customRules: [],
      });
    }

    if (dto.leadDataMonths !== undefined) policy.leadDataMonths = dto.leadDataMonths;
    if (dto.financialDataYears !== undefined) policy.financialDataYears = dto.financialDataYears;
    if (dto.auditLogMonths !== undefined) policy.auditLogMonths = dto.auditLogMonths;
    if (dto.customRules !== undefined) policy.customRules = dto.customRules;

    const saved = await this.retentionRepository.save(policy);

    this.eventEmitter.emit('privacy.retention.updated', {
      tenantId,
      policy: this.toRetentionPolicy(saved),
    });

    this.logger.log(`Retention policy updated for tenant ${tenantId}`);

    return this.toRetentionPolicy(saved);
  }

  // =========================================================================
  // ANONYMIZATION
  // =========================================================================

  /**
   * Anonymize personal data for a subject (one-way, irreversible).
   * Requirement 12.3: Anonymization that cannot be reversed.
   */
  async anonymize(
    subjectId: string,
    tenantId: string,
    scope: AnonymizationScope,
  ): Promise<void> {
    // Generate a deterministic but irreversible anonymous ID
    const anonymousId = this.generateAnonymousId(subjectId, tenantId);

    // Replace subject_id in consents with anonymous hash
    const consents = await this.consentRepository.find({
      where: { tenantId, subjectId },
    });

    for (const consent of consents) {
      consent.subjectId = anonymousId;
      // Clear collection method for full anonymization
      if (scope === 'full') {
        consent.collectionMethod = 'anonymized';
      }
    }

    if (consents.length > 0) {
      await this.consentRepository.save(consents);
    }

    // Emit event for other modules to anonymize their data
    this.eventEmitter.emit('privacy.anonymization.requested', {
      tenantId,
      originalSubjectId: subjectId,
      anonymousId,
      scope,
    });

    this.logger.log(
      `Anonymized data for subject ${subjectId} in tenant ${tenantId} (scope: ${scope})`,
    );
  }

  // =========================================================================
  // ROPA (Record of Processing Activities)
  // =========================================================================

  /**
   * Get all ROPA records for a tenant.
   * Requirement 12.7: Record of Processing Activities.
   */
  async getROPA(tenantId: string): Promise<ROPARecord[]> {
    const records = await this.ropaRepository.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });

    return records.map((r) => this.toROPARecord(r));
  }

  /**
   * Create a new ROPA record for a tenant.
   */
  async createROPARecord(
    tenantId: string,
    dto: {
      processingActivity: string;
      purpose: string;
      dataCategories: string[];
      dataSubjects: string[];
      recipients: string[];
      retentionPeriod: string;
      securityMeasures: string[];
      legalBasis: string;
    },
  ): Promise<ROPARecord> {
    const record = this.ropaRepository.create({
      tenantId,
      processingActivity: dto.processingActivity,
      purpose: dto.purpose,
      dataCategories: dto.dataCategories,
      dataSubjects: dto.dataSubjects,
      recipients: dto.recipients,
      retentionPeriod: dto.retentionPeriod,
      securityMeasures: dto.securityMeasures,
      legalBasis: dto.legalBasis,
    });

    const saved = await this.ropaRepository.save(record);
    this.logger.log(
      `ROPA record created for tenant ${tenantId}: ${dto.processingActivity}`,
    );

    return this.toROPARecord(saved);
  }

  // =========================================================================
  // DPO CONTACT
  // =========================================================================

  /**
   * Get DPO contact information for a tenant.
   * Requirement 12.9: DPO contact configuration.
   */
  async getDPOContact(tenantId: string): Promise<DPOContact> {
    const contact = await this.dpoRepository.findOne({
      where: { tenantId },
    });

    if (!contact) {
      throw new NotFoundException(
        `DPO contact not configured for tenant ${tenantId}`,
      );
    }

    return this.toDPOContact(contact);
  }

  /**
   * Create or update DPO contact for a tenant.
   */
  async updateDPOContact(
    tenantId: string,
    dto: UpdateDPOContactDto,
  ): Promise<DPOContact> {
    let contact = await this.dpoRepository.findOne({
      where: { tenantId },
    });

    if (!contact) {
      if (!dto.name || !dto.email) {
        throw new BadRequestException(
          'Name and email are required when creating DPO contact',
        );
      }
      contact = this.dpoRepository.create({
        tenantId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone ?? null,
        address: dto.address ?? null,
      });
    } else {
      if (dto.name !== undefined) contact.name = dto.name;
      if (dto.email !== undefined) contact.email = dto.email;
      if (dto.phone !== undefined) contact.phone = dto.phone ?? null;
      if (dto.address !== undefined) contact.address = dto.address ?? null;
    }

    const saved = await this.dpoRepository.save(contact);
    this.logger.log(`DPO contact updated for tenant ${tenantId}`);

    return this.toDPOContact(saved);
  }

  // =========================================================================
  // CONSENT-GATED PROCESSING
  // =========================================================================

  /**
   * Check if processing is allowed for a subject+purpose.
   * Requirement 12.8: Block processing when consent revoked/expired.
   * Returns true if processing is allowed (active consent exists).
   */
  async isProcessingAllowed(
    subjectId: string,
    purpose: string,
    tenantId: string,
  ): Promise<boolean> {
    return this.checkConsent(subjectId, purpose, tenantId);
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  /**
   * Generate a one-way anonymous ID from a subject ID.
   * Uses SHA-256 hashing — irreversible by design.
   */
  private generateAnonymousId(subjectId: string, tenantId: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(`${tenantId}:${subjectId}:anonymized`)
      .digest('hex');
    return `anon_${hash.substring(0, 16)}`;
  }

  private toConsentRecord(entity: Consent): ConsentRecord {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      subjectId: entity.subjectId,
      purpose: entity.purpose,
      collectionMethod: entity.collectionMethod,
      grantedAt: entity.grantedAt,
      expiresAt: entity.expiresAt ?? undefined,
      revokedAt: entity.revokedAt ?? undefined,
      status: entity.status,
    };
  }

  private toDeletionResult(entity: DeletionRequest): DeletionResult {
    return {
      id: entity.id,
      subjectId: entity.subjectId,
      tenantId: entity.tenantId,
      deletedFrom: entity.deletedFrom,
      requestedAt: entity.requestedAt,
      completedAt: entity.completedAt ?? undefined,
      deadline: entity.deadline,
      status: entity.status,
    };
  }

  private toRetentionPolicy(entity: RetentionPolicyEntity): RetentionPolicy {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      leadDataMonths: entity.leadDataMonths,
      financialDataYears: entity.financialDataYears,
      auditLogMonths: entity.auditLogMonths,
      customRules: entity.customRules,
      updatedAt: entity.updatedAt,
    };
  }

  private toROPARecord(entity: ROPARecordEntity): ROPARecord {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      processingActivity: entity.processingActivity,
      purpose: entity.purpose,
      dataCategories: entity.dataCategories,
      dataSubjects: entity.dataSubjects,
      recipients: entity.recipients,
      retentionPeriod: entity.retentionPeriod,
      securityMeasures: entity.securityMeasures,
      legalBasis: entity.legalBasis,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }

  private toDPOContact(entity: DPOContactEntity): DPOContact {
    return {
      id: entity.id,
      tenantId: entity.tenantId,
      name: entity.name,
      email: entity.email,
      phone: entity.phone ?? undefined,
      address: entity.address ?? undefined,
      updatedAt: entity.updatedAt,
    };
  }
}
