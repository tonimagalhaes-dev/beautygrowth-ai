import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdatePromptDto {
  @IsString()
  @IsNotEmpty()
  content: string;

  @IsString()
  @IsNotEmpty()
  version: string; // new semver version

  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string;
}
