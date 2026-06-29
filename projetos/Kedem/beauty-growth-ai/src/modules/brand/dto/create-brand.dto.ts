import {
  IsString,
  IsArray,
  ValidateNested,
  MaxLength,
  MinLength,
  ArrayMinSize,
  ArrayMaxSize,
  IsOptional,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ColorEntryDto } from './color-entry.dto';

export class CreateBrandDto {
  @IsString()
  @MinLength(1, { message: 'Voice tone is required' })
  @MaxLength(500, { message: 'Voice tone must be at most 500 characters' })
  voiceTone: string;

  @IsArray()
  @ValidateNested({ each: true })
  @ArrayMinSize(1, { message: 'Color palette must have at least 1 color' })
  @ArrayMaxSize(6, { message: 'Color palette must have at most 6 colors' })
  @Type(() => ColorEntryDto)
  colorPalette: ColorEntryDto[];

  @IsString()
  @MinLength(1, { message: 'Target audience is required' })
  @MaxLength(300, { message: 'Target audience must be at most 300 characters' })
  targetAudience: string;

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1, { message: 'At least 1 differential is required' })
  @ArrayMaxSize(5, { message: 'At most 5 differentials allowed' })
  differentials: string[];

  @IsArray()
  @IsString({ each: true })
  @ArrayMinSize(1, { message: 'At least 1 value is required' })
  @ArrayMaxSize(5, { message: 'At most 5 values allowed' })
  values: string[];

  @IsOptional()
  @IsString()
  logo?: string;
}
