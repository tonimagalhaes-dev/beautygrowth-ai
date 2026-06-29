import { IsString, IsNotEmpty, IsOptional, IsDateString } from 'class-validator';

export class RecordConsentDto {
  @IsString()
  @IsNotEmpty()
  subjectId: string;

  @IsString()
  @IsNotEmpty()
  purpose: string;

  @IsString()
  @IsNotEmpty()
  collectionMethod: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
