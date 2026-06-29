import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { AgentType, PromptFunction } from '../entities/prompt.entity';

export class CreatePromptDto {
  @IsEnum(['content', 'campaigns', 'customer_service'])
  agentType: AgentType;

  @IsEnum(['system', 'task', 'formatting'])
  function: PromptFunction;

  @IsString()
  @IsNotEmpty()
  content: string;

  @IsString()
  @IsNotEmpty()
  version: string; // initial version e.g. "1.0.0"

  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;
}
