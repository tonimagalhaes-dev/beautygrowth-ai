import { IsUUID, IsOptional, IsDate, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { DomainEventPayload } from '../interfaces';

/**
 * DTO for the 'guardrails.violation' event payload.
 * Validates: Requirements 5.1, 9.3
 */
export class GuardrailsViolationPayloadDto implements DomainEventPayload {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  agentId: string;

  @IsString()
  guardrailName: string;

  @IsString()
  violationType: string;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  timestamp?: Date;

  @IsOptional()
  @IsUUID('4')
  correlationId?: string;
}
