import { IsDateString } from 'class-validator';

export class DashboardMetricsDto {
  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;
}
