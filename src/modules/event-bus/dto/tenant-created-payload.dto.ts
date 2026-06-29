import { IsUUID, IsOptional, IsDate } from 'class-validator';
import { Type } from 'class-transformer';
import { DomainEventPayload } from '../interfaces';

/**
 * DTO for the 'tenant.created' event payload.
 * Validates: Requirements 5.1, 9.3
 */
export class TenantCreatedPayloadDto implements DomainEventPayload {
  @IsUUID()
  tenantId: string;

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  timestamp?: Date;

  @IsOptional()
  @IsUUID('4')
  correlationId?: string;
}
