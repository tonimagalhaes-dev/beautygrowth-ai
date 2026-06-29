import { IsString, IsOptional, IsDateString } from 'class-validator';

export class LogUserActionDto {
  @IsOptional()
  @IsString()
  traceId?: string;

  @IsString()
  actionType: string;

  @IsString()
  resource: string;

  @IsString()
  result: string;

  @IsOptional()
  @IsDateString()
  timestamp?: string;
}
