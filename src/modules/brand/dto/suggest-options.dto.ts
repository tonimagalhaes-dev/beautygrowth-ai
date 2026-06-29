import { IsString, IsArray, IsOptional, MinLength } from 'class-validator';

export class SuggestOptionsDto {
  @IsString()
  @MinLength(1, { message: 'Field name is required' })
  field: string;

  @IsString()
  @MinLength(1, { message: 'Clinic name is required' })
  clinicName: string;

  @IsArray()
  @IsString({ each: true })
  specialties: string[];

  @IsOptional()
  @IsString()
  targetAudience?: string;
}
