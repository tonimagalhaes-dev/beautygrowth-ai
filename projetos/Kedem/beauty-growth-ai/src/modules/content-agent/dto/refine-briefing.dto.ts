import { IsString, IsNotEmpty, IsUUID, MaxLength } from 'class-validator';

export class RefineBriefingDto {
  @IsUUID('4', { message: 'O campo executionId deve ser um UUID válido' })
  @IsNotEmpty({ message: 'O campo executionId é obrigatório' })
  executionId: string;

  @IsString()
  @IsNotEmpty({ message: 'O campo instrucoes é obrigatório' })
  @MaxLength(500, {
    message: 'O campo instrucoes deve ter no máximo 500 caracteres',
  })
  instrucoes: string;
}
