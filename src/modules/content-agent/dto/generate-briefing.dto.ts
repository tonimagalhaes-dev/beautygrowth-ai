import {
  IsString,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsIn,
  MaxLength,
  ArrayMinSize,
} from 'class-validator';

export type RedeSocial = 'instagram' | 'facebook' | 'tiktok';

export class GenerateBriefingDto {
  @IsString()
  @IsNotEmpty({ message: 'O campo tema é obrigatório' })
  @MaxLength(500, { message: 'O campo tema deve ter no máximo 500 caracteres' })
  tema: string;

  @IsOptional()
  @IsUUID('4', { message: 'O campo procedimento deve ser um UUID válido' })
  procedimento?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300, {
    message: 'O campo publicoAlvoOverride deve ter no máximo 300 caracteres',
  })
  publicoAlvoOverride?: string;

  @IsArray()
  @ArrayMinSize(1, {
    message: 'Selecione ao menos uma rede social',
  })
  @IsIn(['instagram', 'facebook', 'tiktok'], {
    each: true,
    message:
      'Cada rede social deve ser uma das seguintes: instagram, facebook, tiktok',
  })
  redesSociais: RedeSocial[];

  @IsOptional()
  @IsString()
  idioma?: string = 'pt-BR';
}
