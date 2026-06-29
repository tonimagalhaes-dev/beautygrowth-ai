import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class PeriodDto {
  @IsDateString()
  start: string;

  @IsDateString()
  end: string;
}

export class ClearMemoryDto {
  @IsEnum(['all', 'short_term', 'long_term'])
  type: 'all' | 'short_term' | 'long_term';

  @IsOptional()
  @ValidateNested()
  @Type(() => PeriodDto)
  period?: PeriodDto;

  @IsBoolean()
  requireConfirmation: boolean;
}
