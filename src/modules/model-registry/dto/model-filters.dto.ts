import { IsEnum, IsOptional } from 'class-validator';
import { ModelCapability, ModelProvider, ModelStatus } from '../entities/ai-model.entity';

export class ModelFiltersDto {
  @IsOptional()
  @IsEnum(['openai', 'anthropic', 'google', 'meta', 'alibaba', 'deepseek'])
  provider?: ModelProvider;

  @IsOptional()
  @IsEnum(['available', 'deprecated', 'testing'])
  status?: ModelStatus;

  @IsOptional()
  @IsEnum(['text_generation', 'vision', 'embeddings', 'function_calling'])
  capability?: ModelCapability;
}
