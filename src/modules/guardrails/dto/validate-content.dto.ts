import { IsString, IsNotEmpty, IsOptional, IsUUID } from 'class-validator';

export class ValidateContentDto {
  @IsString()
  @IsNotEmpty()
  content: string;

  @IsOptional()
  @IsUUID()
  agentId?: string;
}
