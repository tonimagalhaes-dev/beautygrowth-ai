import {
  IsOptional,
  IsNumber,
  IsUUID,
  IsArray,
  IsString,
  Min,
  Max,
} from 'class-validator';

export class UpdateAgentConfigDto {
  @IsOptional()
  @IsUUID()
  modelId?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.0)
  @Max(2.0)
  temperature?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  maxTokens?: number;

  @IsOptional()
  @IsUUID()
  systemPromptId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  knowledgeCategories?: string[];

  @IsOptional()
  @IsUUID()
  fallbackModelId?: string;
}
