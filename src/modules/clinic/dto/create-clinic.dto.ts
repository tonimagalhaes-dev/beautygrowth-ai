import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { AddressDto } from './address.dto';
import { IsValidSpecialty } from '../validators/specialty.validator';

export class CreateClinicDto {
  @IsNotEmpty({ message: 'Nome da clínica é obrigatório' })
  @IsString()
  @MaxLength(120, { message: 'Nome da clínica deve ter no máximo 120 caracteres' })
  name: string;

  @IsNotEmpty({ message: 'Telefone é obrigatório' })
  @IsString()
  @Matches(/^\d{10,11}$/, {
    message: 'Telefone deve conter 10 ou 11 dígitos numéricos (formato brasileiro com DDD)',
  })
  phone: string;

  @IsNotEmpty({ message: 'E-mail é obrigatório' })
  @IsEmail({}, { message: 'E-mail deve estar em formato válido (RFC 5322)' })
  email: string;

  @IsArray({ message: 'Especialidades deve ser um array' })
  @ArrayMinSize(1, { message: 'Pelo menos uma especialidade deve ser selecionada' })
  @ArrayMaxSize(20, { message: 'Máximo de 20 especialidades permitidas' })
  @IsString({ each: true })
  @IsValidSpecialty({ each: true })
  specialties: string[];

  @IsNotEmpty({ message: 'Público-alvo é obrigatório' })
  @IsString()
  targetAudience: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => AddressDto)
  address?: AddressDto;

  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Website deve ter no máximo 500 caracteres' })
  website?: string;
}
