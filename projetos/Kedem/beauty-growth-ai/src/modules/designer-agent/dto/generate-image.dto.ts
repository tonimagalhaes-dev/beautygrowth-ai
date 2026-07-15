import {
  IsString,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsBoolean,
  IsIn,
  MinLength,
  MaxLength,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { Transform } from 'class-transformer';

export type RedeSocial = 'instagram' | 'facebook' | 'tiktok';

export class GenerateImageDto {
  @IsString()
  @IsNotEmpty({ message: 'O campo descricaoVisual é obrigatório' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MinLength(10, {
    message: 'O campo descricaoVisual deve ter no mínimo 10 caracteres',
  })
  @MaxLength(1000, {
    message: 'O campo descricaoVisual deve ter no máximo 1000 caracteres',
  })
  descricaoVisual: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Selecione ao menos uma rede social' })
  @ArrayMaxSize(3, { message: 'Selecione no máximo 3 redes sociais' })
  @IsIn(['instagram', 'facebook', 'tiktok'], {
    each: true,
    message:
      'Cada rede social deve ser uma das seguintes: instagram, facebook, tiktok',
  })
  redesSociais: RedeSocial[];

  @IsOptional()
  @IsUUID('4', {
    message: 'O campo contentExecutionId deve ser um UUID válido',
  })
  contentExecutionId?: string;

  @IsOptional()
  @IsBoolean({ message: 'O campo aplicarLogoOverlay deve ser um booleano' })
  aplicarLogoOverlay?: boolean = false;

  @IsOptional()
  @IsString()
  @MaxLength(300, {
    message:
      'O campo estiloVisualAdicional deve ter no máximo 300 caracteres',
  })
  estiloVisualAdicional?: string;
}
