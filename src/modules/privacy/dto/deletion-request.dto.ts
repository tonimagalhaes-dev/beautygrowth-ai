import { IsString, IsNotEmpty } from 'class-validator';

export class DeletionRequestDto {
  @IsString()
  @IsNotEmpty()
  subjectId: string;
}
