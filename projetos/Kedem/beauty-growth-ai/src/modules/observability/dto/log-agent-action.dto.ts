import { IsString, IsOptional, IsEnum, IsNumber, IsArray, IsDateString } from 'class-validator';

export class TokenUsageDto {
  @IsNumber()
  inputTokens: number;

  @IsNumber()
  outputTokens: number;

  @IsString()
  modelId: string;

  @IsString()
  agentId: string;
}

export class LogAgentActionDto {
  @IsOptional()
  @IsString()
  traceId?: string;

  @IsString()
  agentId: string;

  @IsString()
  actionType: string;

  @IsString()
  input: string;

  @IsString()
  output: string;

  @IsNumber()
  durationMs: number;

  @IsEnum(['success', 'error'])
  status: 'success' | 'error';

  @IsOptional()
  tokensUsed?: TokenUsageDto;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  guardrailViolations?: string[];

  @IsOptional()
  @IsDateString()
  timestamp?: string;
}
