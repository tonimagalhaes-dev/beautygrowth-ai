import { IsUUID, IsOptional, IsDate, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { DomainEventPayload } from '../interfaces';

/**
 * DTO for the 'guardrails.changed' event payload.
 * Validates: Requirements 5.1, 9.3
 */
export class GuardrailsChangedPayloadDto implements DomainEventPayload {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  guardrailId: string;

  @IsIn(['created', 'updated', 'deleted'])
  action: 'created' | 'updated' | 'deleted';

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  timestamp?: Date;

  @IsOptional()
  @IsUUID('4')
  correlationId?: string;
}
