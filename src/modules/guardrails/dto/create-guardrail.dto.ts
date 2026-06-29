import { IsString, IsNotEmpty, IsArray, IsOptional, IsEnum, IsInt, Min, Max } from 'class-validator';

export class CreateGuardrailDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsOptional()
  @IsString()
  pattern?: string;

  @IsOptional()
  @IsString()
  classifier?: string;

  @IsArray()
  @IsString({ each: true })
  categories: string[];

  @IsEnum(['block', 'regenerate', 'warn'])
  action: 'block' | 'regenerate' | 'warn';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxRetries?: number; // defaults to 3
}
