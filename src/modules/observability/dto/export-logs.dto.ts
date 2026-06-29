import { IsString, IsOptional, IsEnum, IsDateString } from 'class-validator';

export class ExportLogsDto {
  @IsOptional()
  @IsString()
  agentId?: string;

  @IsOptional()
  @IsString()
  actionType?: string;

  @IsOptional()
  @IsEnum(['success', 'error'])
  status?: 'success' | 'error';

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsEnum(['json', 'csv'])
  format: 'json' | 'csv';
}
