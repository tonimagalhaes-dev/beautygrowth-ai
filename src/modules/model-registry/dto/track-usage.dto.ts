import { IsInt, IsUUID, Min } from 'class-validator';

export class TrackUsageDto {
  @IsInt()
  @Min(0)
  inputTokens: number;

  @IsInt()
  @Min(0)
  outputTokens: number;

  @IsUUID()
  agentId: string;
}
