import { Guardrail } from '../entities/guardrail.entity';
import { CreateGuardrailDto } from '../dto/create-guardrail.dto';
import { UpdateGuardrailDto } from '../dto/update-guardrail.dto';

/**
 * Result of content validation against guardrails.
 */
export interface ValidationResult {
  isValid: boolean;
  violations: Violation[];
  checkedGuardrails: number;
}

/**
 * A single guardrail violation.
 */
export interface Violation {
  guardrailId: string;
  guardrailName: string;
  severity: 'critical' | 'high' | 'medium';
  description: string;
  matchedContent: string;
}

/**
 * Guardrail rule definition.
 */
export interface GuardrailRule {
  pattern?: string; // regex or keywords
  classifier?: string; // classification model
  categories: string[]; // violation categories
  action: 'block' | 'regenerate' | 'warn';
  maxRetries: number; // default: 3
}

/**
 * Date range for filtering reports.
 */
export interface DateRange {
  start: Date;
  end: Date;
}

/**
 * Violation report for admin.
 */
export interface ViolationReport {
  tenantId: string;
  period: DateRange;
  totalViolations: number;
  byGuardrail: { guardrailId: string; guardrailName: string; count: number }[];
  byAgent: { agentId: string; count: number }[];
  trends: { date: string; count: number }[];
}

/**
 * Regeneration result from validation pipeline.
 */
export interface RegenerationResult {
  success: boolean;
  attempt: number;
  maxRetries: number;
  blocked: boolean;
  violations: Violation[];
}

/**
 * Guardrails Service interface.
 */
export interface IGuardrailsService {
  validate(content: string, tenantId: string, agentId?: string): Promise<ValidationResult>;
  getSystemGuardrails(): Promise<Guardrail[]>;
  getTenantGuardrails(tenantId: string): Promise<Guardrail[]>;
  createTenantGuardrail(tenantId: string, dto: CreateGuardrailDto): Promise<Guardrail>;
  updateTenantGuardrail(guardrailId: string, dto: UpdateGuardrailDto): Promise<Guardrail>;
  rollback(guardrailId: string, version: number): Promise<Guardrail>;
  getViolationReport(tenantId: string, period: DateRange): Promise<ViolationReport>;
}
