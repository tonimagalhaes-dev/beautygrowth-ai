import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsBoolean,
  MaxLength,
} from 'class-validator';

export class FromContentDto {
  @IsUUID('4', {
    message: 'O campo contentExecutionId deve ser um UUID válido',
  })
  @IsNotEmpty({ message: 'O campo contentExecutionId é obrigatório' })
  contentExecutionId: string;

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
