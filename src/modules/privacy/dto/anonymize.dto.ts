import { IsString, IsNotEmpty, IsIn } from 'class-validator';

export class AnonymizeDto {
  @IsString()
  @IsNotEmpty()
  subjectId: string;

  @IsIn(['full', 'partial'])
  scope: 'full' | 'partial';
}
