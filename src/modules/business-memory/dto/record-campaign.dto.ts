import { IsString, IsDateString, IsOptional, IsIn } from 'class-validator';

export class RecordCampaignDto {
  @IsString()
  campaignId: string;

  @IsString()
  name: string;

  @IsString()
  type: string;

  @IsIn(['completed', 'cancelled'])
  status: 'completed' | 'cancelled';

  @IsDateString()
  startedAt: string;

  @IsDateString()
  completedAt: string;

  @IsOptional()
  metrics?: Record<string, any>;
}
