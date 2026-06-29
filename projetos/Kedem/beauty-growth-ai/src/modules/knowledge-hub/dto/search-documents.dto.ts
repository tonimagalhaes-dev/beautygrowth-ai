import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class SearchDocumentsDto {
  @IsString()
  query: string;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(10)
  @Type(() => Number)
  topK?: number = 5;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',') : value))
  categories?: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  @Type(() => Number)
  minScore?: number;
}
