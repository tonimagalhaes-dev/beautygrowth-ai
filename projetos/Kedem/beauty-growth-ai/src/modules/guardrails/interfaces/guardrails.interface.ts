export interface Guardrail {
  id: string;
  tenantId: string | null; // null = system guardrail
  type: 'system' | 'tenant';
  name: string;
  description: string;
  rule: GuardrailRule;
  version: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface GuardrailRule {
  pattern?: string; // regex or keywords
  classifier?: string; // classification model identifier
  categories: string[]; // violation categories
  action: 'block' | 'regenerate' | 'warn';
  maxRetries: number; // default: 3
}

export interface ValidationResult {
  isValid: boolean;
  violations: Violation[];
  checkedGuardrails: number;
}

export interface Violation {
  guardrailId: string;
  guardrailName: string;
  severity: 'critical' | 'high' | 'medium';
  description: string;
  matchedContent: string;
}

export interface CreateGuardrailDto {
  name: string;
  description: string;
  rule: GuardrailRule;
}

export interface UpdateGuardrailDto {
  name?: string;
  description?: string;
  rule?: GuardrailRule;
  isActive?: boolean;
}

export interface IGuardrailsService {
  validate(content: string, tenantId: string): Promise<ValidationResult>;
  getSystemGuardrails(): Promise<Guardrail[]>;
  getTenantGuardrails(tenantId: string): Promise<Guardrail[]>;
  createTenantGuardrail(
    tenantId: string,
    dto: CreateGuardrailDto,
  ): Promise<Guardrail>;
  updateTenantGuardrail(
    guardrailId: string,
    dto: UpdateGuardrailDto,
  ): Promise<Guardrail>;
}
