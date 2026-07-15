import {
  IsString,
  IsNotEmpty,
  IsUUID,
  IsIn,
  MaxLength,
} from 'class-validator';

import { RedeSocial } from './generate-image.dto';

export class EditImageDto {
  @IsUUID('4', { message: 'O campo executionId deve ser um UUID válido' })
  @IsNotEmpty({ message: 'O campo executionId é obrigatório' })
  executionId: string;

  @IsIn(['instagram', 'facebook', 'tiktok'], {
    message:
      'O campo redeSocial deve ser uma das seguintes: instagram, facebook, tiktok',
  })
  @IsNotEmpty({ message: 'O campo redeSocial é obrigatório' })
  redeSocial: RedeSocial;

  @IsString()
  @IsNotEmpty({ message: 'O campo instrucaoEdicao é obrigatório' })
  @MaxLength(500, {
    message: 'O campo instrucaoEdicao deve ter no máximo 500 caracteres',
  })
  instrucaoEdicao: string;
}
