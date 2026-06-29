import { IsString, IsBoolean, Matches, MinLength } from 'class-validator';

export class ColorEntryDto {
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: 'hex must be a valid color in #RRGGBB format',
  })
  hex: string;

  @IsString()
  @MinLength(1, { message: 'Color name is required' })
  name: string;

  @IsBoolean()
  isPrimary: boolean;
}
