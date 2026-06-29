import {
  IsOptional,
  IsInt,
  Min,
  IsArray,
  ValidateNested,
  IsString,
  IsNotEmpty,
} from 'class-validator';
import { Type } from 'class-transformer';

export class RetentionRuleDto {
  @IsString()
  @IsNotEmpty()
  dataCategory: string;

  @IsInt()
  @Min(1)
  retentionMonths: number;

  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateRetentionPolicyDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  leadDataMonths?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  financialDataYears?: number;

  @IsOptional()
  @IsInt()
  @Min(12)
  auditLogMonths?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RetentionRuleDto)
  customRules?: RetentionRuleDto[];
}
