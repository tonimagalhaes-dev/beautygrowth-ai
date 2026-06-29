import { IsUUID, IsOptional, IsDate, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { DomainEventPayload } from '../interfaces';

/**
 * DTO for the 'brand.updated' event payload.
 * Validates: Requirements 5.1, 9.3
 */
export class BrandUpdatedPayloadDto implements DomainEventPayload {
  @IsUUID()
  tenantId: string;

  @IsUUID()
  brandId: string;

  @IsIn(['created', 'updated'])
  action: 'created' | 'updated';

  @IsOptional()
  @IsDate()
  @Type(() => Date)
  timestamp?: Date;

  @IsOptional()
  @IsUUID('4')
  correlationId?: string;
}
