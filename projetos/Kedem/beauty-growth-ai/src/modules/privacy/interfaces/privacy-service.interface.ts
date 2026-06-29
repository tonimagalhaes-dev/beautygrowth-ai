/**
 * Privacy Service interface — LGPD compliance for BeautyGrowth AI.
 * Handles consent management, data deletion, portability, anonymization,
 * retention policies, and ROPA (Record of Processing Activities).
 */

export interface IPrivacyService {
  recordConsent(dto: ConsentDto): Promise<ConsentRecord>;
  revokeConsent(consentId: string): Promise<void>;
  checkConsent(subjectId: string, purpose: string, tenantId: string): Promise<boolean>;
  handleDeletionRequest(subjectId: string, tenantId: string): Promise<DeletionResult>;
  exportData(subjectId: string, tenantId: string, format: ExportFormat): Promise<DataExport>;
  getRetentionPolicy(tenantId: string): Promise<RetentionPolicy>;
  updateRetentionPolicy(tenantId: string, dto: UpdateRetentionDto): Promise<RetentionPolicy>;
  anonymize(subjectId: string, tenantId: string, scope: AnonymizationScope): Promise<void>;
  getROPA(tenantId: string): Promise<ROPARecord[]>;
  getDPOContact(tenantId: string): Promise<DPOContact>;
  updateDPOContact(tenantId: string, dto: UpdateDPOContactDto): Promise<DPOContact>;
}

export interface ConsentDto {
  tenantId: string;
  subjectId: string;
  purpose: string;
  collectionMethod: string;
  expiresAt?: Date;
}

export interface ConsentRecord {
  id: string;
  tenantId: string;
  subjectId: string;
  purpose: string;
  collectionMethod: string;
  grantedAt: Date;
  expiresAt?: Date;
  revokedAt?: Date;
  status: ConsentStatus;
}

export type ConsentStatus = 'active' | 'revoked' | 'expired';

export interface DeletionResult {
  id: string;
  subjectId: string;
  tenantId: string;
  deletedFrom: string[];
  requestedAt: Date;
  completedAt?: Date;
  deadline: Date; // 15 calendar days from request
  status: DeletionStatus;
}

export type DeletionStatus = 'completed' | 'in_progress' | 'failed';

export interface DataExport {
  subjectId: string;
  tenantId: string;
  format: ExportFormat;
  data: Record<string, any>;
  generatedAt: Date;
  expiresAt: Date; // link expires in 48h
}

export type ExportFormat = 'json' | 'csv';

export interface RetentionPolicy {
  id: string;
  tenantId: string;
  leadDataMonths: number; // default: 12
  financialDataYears: number; // default: 5
  auditLogMonths: number; // minimum: 12
  customRules: RetentionRule[];
  updatedAt: Date;
}

export interface RetentionRule {
  dataCategory: string;
  retentionMonths: number;
  description?: string;
}

export interface UpdateRetentionDto {
  leadDataMonths?: number;
  financialDataYears?: number;
  auditLogMonths?: number;
  customRules?: RetentionRule[];
}

export type AnonymizationScope = 'full' | 'partial';

export interface ROPARecord {
  id: string;
  tenantId: string;
  processingActivity: string;
  purpose: string;
  dataCategories: string[];
  dataSubjects: string[];
  recipients: string[];
  retentionPeriod: string;
  securityMeasures: string[];
  legalBasis: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DPOContact {
  id: string;
  tenantId: string;
  name: string;
  email: string;
  phone?: string;
  address?: string;
  updatedAt: Date;
}

export interface UpdateDPOContactDto {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
}
