import { IsString, IsNotEmpty, IsArray } from 'class-validator';

export class CreateROPARecordDto {
  @IsString()
  @IsNotEmpty()
  processingActivity: string;

  @IsString()
  @IsNotEmpty()
  purpose: string;

  @IsArray()
  @IsString({ each: true })
  dataCategories: string[];

  @IsArray()
  @IsString({ each: true })
  dataSubjects: string[];

  @IsArray()
  @IsString({ each: true })
  recipients: string[];

  @IsString()
  @IsNotEmpty()
  retentionPeriod: string;

  @IsArray()
  @IsString({ each: true })
  securityMeasures: string[];

  @IsString()
  @IsNotEmpty()
  legalBasis: string;
}
