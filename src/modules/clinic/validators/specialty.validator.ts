import {
  registerDecorator,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { SPECIALTIES_CATALOG } from '../constants/specialties';

@ValidatorConstraint({ name: 'isValidSpecialty', async: false })
export class IsValidSpecialtyConstraint implements ValidatorConstraintInterface {
  validate(value: string): boolean {
    return SPECIALTIES_CATALOG.includes(value as any);
  }

  defaultMessage(): string {
    return `Especialidade "$value" não está no catálogo predefinido de especialidades`;
  }
}

export function IsValidSpecialty(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidSpecialtyConstraint,
    });
  };
}
