import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AddressDto } from './address.dto';
import { IsValidSpecialty } from '../validators/specialty.validator';

export class UpdateClinicDto {
  @IsOptional()
  @IsNotEmpty({ message: 'Nome da clínica não pode ser vazio' })
  @IsString()
  @MaxLength(120, { message: 'Nome da clínica deve ter no máximo 120 caracteres' })
  name?: string;

  @IsOptional()
  @IsNotEmpty({ message: 'Telefone não pode ser vazio' })
  @IsString()
  @Matches(/^\d{10,11}$/, {
    message: 'Telefone deve conter 10 ou 11 dígitos numéricos (formato brasileiro com DDD)',
  })
  phone?: string;

  @IsOptional()
  @IsNotEmpty({ message: 'E-mail não pode ser vazio' })
  @IsEmail({}, { message: 'E-mail deve estar em formato válido (RFC 5322)' })
  email?: string;

  @IsOptional()
  @IsArray({ message: 'Especialidades deve ser um array' })
  @ArrayMinSize(1, { message: 'Pelo menos uma especialidade deve ser selecionada' })
  @ArrayMaxSize(20, { message: 'Máximo de 20 especialidades permitidas' })
  @IsString({ each: true })
  @IsValidSpecialty({ each: true })
  specialties?: string[];

  @IsOptional()
  @IsNotEmpty({ message: 'Público-alvo não pode ser vazio' })
  @IsString()
  targetAudience?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Website deve ter no máximo 500 caracteres' })
  website?: string;

  /**
   * Version field for optimistic locking.
   * Client must send the current version they have to detect conflicts.
   */
  @IsNotEmpty({ message: 'Versão é obrigatória para atualização (optimistic locking)' })
  @IsInt()
  @Min(1)
  version: number;
}
