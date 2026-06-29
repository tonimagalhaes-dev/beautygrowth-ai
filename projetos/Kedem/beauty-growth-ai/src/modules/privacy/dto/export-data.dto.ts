import { IsString, IsNotEmpty, IsIn } from 'class-validator';

export class ExportDataDto {
  @IsString()
  @IsNotEmpty()
  subjectId: string;

  @IsIn(['json', 'csv'])
  format: 'json' | 'csv';
}
