import { IsString, IsOptional, IsArray, IsEnum, IsInt, Min, Max, IsBoolean } from 'class-validator';

export class UpdateGuardrailDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  pattern?: string;

  @IsOptional()
  @IsString()
  classifier?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  categories?: string[];

  @IsOptional()
  @IsEnum(['block', 'regenerate', 'warn'])
  action?: 'block' | 'regenerate' | 'warn';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxRetries?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
