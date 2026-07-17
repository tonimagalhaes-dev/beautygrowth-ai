import { IsBoolean, IsNotEmpty, IsUUID } from 'class-validator';

/**
 * DTO for confirming or declining a similar match from the cache.
 * Used by POST /api/prompt-cache/confirm-similar
 */
export class ConfirmSimilarMatchDto {
  @IsUUID('4', { message: 'O campo cacheEntryId deve ser um UUID válido' })
  @IsNotEmpty({ message: 'O campo cacheEntryId é obrigatório' })
  cacheEntryId: string;

  @IsBoolean({ message: 'O campo confirmed deve ser um booleano' })
  @IsNotEmpty({ message: 'O campo confirmed é obrigatório' })
  confirmed: boolean;
}
