import 'reflect-metadata';
import * as fc from 'fast-check';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateClinicDto } from '../dto/create-clinic.dto';
import { SPECIALTIES_CATALOG } from '../constants/specialties';

/**
 * Property 2: Validação de Dados de Clínica
 *
 * For any clinic registration input, if the email doesn't follow RFC 5322,
 * OR the phone has less than 10 or more than 11 digits,
 * OR the name is empty,
 * OR specialties is empty or has more than 20 items,
 * the validation MUST reject the input.
 *
 * Conversely, if all required fields are valid, registration MUST be accepted
 * and the returned data must be identical to what was submitted.
 *
 * **Validates: Requirements 1.1, 1.3, 1.5**
 */

// --- Arbitraries ---

// Valid name: non-empty string up to 120 characters (class-validator @IsNotEmpty rejects only '')
const validNameArb = fc.string({ minLength: 1, maxLength: 120 });

// Valid phone: 10 or 11 numeric digits
const validPhoneArb = fc.oneof(
  fc.stringOf(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'), {
    minLength: 10,
    maxLength: 10,
  }),
  fc.stringOf(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'), {
    minLength: 11,
    maxLength: 11,
  }),
);

// Valid email: generated from parts to ensure RFC 5322 compliance
const validEmailArb = fc
  .tuple(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 1,
      maxLength: 15,
    }),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 1,
      maxLength: 10,
    }),
    fc.constantFrom('com', 'com.br', 'net', 'org', 'io'),
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);

// Valid specialties: 1-20 items from the catalog
const validSpecialtiesArb = fc
  .subarray([...SPECIALTIES_CATALOG], { minLength: 1, maxLength: 20 })
  .filter((arr) => arr.length >= 1);

// Valid target audience (non-empty for @IsNotEmpty)
const validTargetAudienceArb = fc.string({ minLength: 1, maxLength: 200 });

// Full valid CreateClinicDto arbitrary
const validClinicDtoArb = fc
  .tuple(validNameArb, validPhoneArb, validEmailArb, validSpecialtiesArb, validTargetAudienceArb)
  .map(([name, phone, email, specialties, targetAudience]) => ({
    name,
    phone,
    email,
    specialties,
    targetAudience,
  }));

// --- Invalid arbitraries ---

// Invalid email: strings that don't follow email format
const invalidEmailArb = fc.oneof(
  fc.constant(''),
  fc.constant('notanemail'),
  fc.constant('missing@'),
  fc.constant('@nodomain.com'),
  fc.constant('spaces in@email.com'),
  fc.constant('double@@at.com'),
  fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 20 }),
);

// Invalid phone: less than 10 digits or more than 11 digits, or non-numeric
const invalidPhoneArb = fc.oneof(
  // Too short (less than 10 digits)
  fc.stringOf(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'), {
    minLength: 1,
    maxLength: 9,
  }),
  // Too long (more than 11 digits)
  fc.stringOf(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9'), {
    minLength: 12,
    maxLength: 15,
  }),
  // Non-numeric characters
  fc.stringOf(fc.constantFrom(...'abcdefghij!@#$%()-+'.split('')), { minLength: 10, maxLength: 11 }),
  // Empty
  fc.constant(''),
);

// Empty name: class-validator @IsNotEmpty() rejects only '', null, undefined
const emptyNameArb = fc.constant('');

// Invalid specialties: empty array or more than 20 items
const emptySpecialtiesArb = fc.constant([] as string[]);

// More than 20 specialties (duplicate catalog items to exceed 20)
const tooManySpecialtiesArb = fc
  .array(fc.constantFrom(...SPECIALTIES_CATALOG), { minLength: 21, maxLength: 25 })
  .filter((arr) => arr.length > 20);

// Invalid specialty (not from catalog)
const invalidSpecialtyValueArb = fc.tuple(
  fc.constantFrom(...SPECIALTIES_CATALOG),
  fc.string({ minLength: 5, maxLength: 30 }).filter((s) => !SPECIALTIES_CATALOG.includes(s as any)),
).map(([valid, invalid]) => [valid, invalid]);

// --- Helper functions ---

async function validateDto(input: Record<string, any>): Promise<{ isValid: boolean; errorFields: string[] }> {
  const dto = plainToInstance(CreateClinicDto, input);
  const errors = await validate(dto);
  return {
    isValid: errors.length === 0,
    errorFields: errors.map((e) => e.property),
  };
}

// --- Tests ---

describe('Property 2: Validação de Dados de Clínica', () => {
  describe('Valid inputs MUST be accepted', () => {
    it('should accept any clinic input with all required fields valid', async () => {
      await fc.assert(
        fc.asyncProperty(validClinicDtoArb, async (input) => {
          const { isValid } = await validateDto(input);
          expect(isValid).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('should preserve submitted data identically when validation passes', async () => {
      await fc.assert(
        fc.asyncProperty(validClinicDtoArb, async (input) => {
          const dto = plainToInstance(CreateClinicDto, input);
          const errors = await validate(dto);

          if (errors.length === 0) {
            expect(dto.name).toBe(input.name);
            expect(dto.phone).toBe(input.phone);
            expect(dto.email).toBe(input.email);
            expect(dto.specialties).toEqual(input.specialties);
            expect(dto.targetAudience).toBe(input.targetAudience);
          }
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('Invalid email MUST be rejected', () => {
    it('should reject clinic input when email does not follow RFC 5322', async () => {
      await fc.assert(
        fc.asyncProperty(
          validNameArb,
          validPhoneArb,
          invalidEmailArb,
          validSpecialtiesArb,
          validTargetAudienceArb,
          async (name, phone, email, specialties, targetAudience) => {
            const { isValid, errorFields } = await validateDto({
              name,
              phone,
              email,
              specialties,
              targetAudience,
            });
            expect(isValid).toBe(false);
            expect(errorFields).toContain('email');
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Invalid phone MUST be rejected', () => {
    it('should reject clinic input when phone has less than 10 or more than 11 digits', async () => {
      await fc.assert(
        fc.asyncProperty(
          validNameArb,
          invalidPhoneArb,
          validEmailArb,
          validSpecialtiesArb,
          validTargetAudienceArb,
          async (name, phone, email, specialties, targetAudience) => {
            const { isValid, errorFields } = await validateDto({
              name,
              phone,
              email,
              specialties,
              targetAudience,
            });
            expect(isValid).toBe(false);
            expect(errorFields).toContain('phone');
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Empty name MUST be rejected', () => {
    it('should reject clinic input when name is empty string', async () => {
      await fc.assert(
        fc.asyncProperty(
          emptyNameArb,
          validPhoneArb,
          validEmailArb,
          validSpecialtiesArb,
          validTargetAudienceArb,
          async (name, phone, email, specialties, targetAudience) => {
            const { isValid, errorFields } = await validateDto({
              name,
              phone,
              email,
              specialties,
              targetAudience,
            });
            expect(isValid).toBe(false);
            expect(errorFields).toContain('name');
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Invalid specialties MUST be rejected', () => {
    it('should reject clinic input when specialties array is empty', async () => {
      await fc.assert(
        fc.asyncProperty(
          validNameArb,
          validPhoneArb,
          validEmailArb,
          emptySpecialtiesArb,
          validTargetAudienceArb,
          async (name, phone, email, specialties, targetAudience) => {
            const { isValid, errorFields } = await validateDto({
              name,
              phone,
              email,
              specialties,
              targetAudience,
            });
            expect(isValid).toBe(false);
            expect(errorFields).toContain('specialties');
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should reject clinic input when specialties has more than 20 items', async () => {
      await fc.assert(
        fc.asyncProperty(
          validNameArb,
          validPhoneArb,
          validEmailArb,
          tooManySpecialtiesArb,
          validTargetAudienceArb,
          async (name, phone, email, specialties, targetAudience) => {
            const { isValid, errorFields } = await validateDto({
              name,
              phone,
              email,
              specialties,
              targetAudience,
            });
            expect(isValid).toBe(false);
            expect(errorFields).toContain('specialties');
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should reject clinic input when specialties contain values not in catalog', async () => {
      await fc.assert(
        fc.asyncProperty(
          validNameArb,
          validPhoneArb,
          validEmailArb,
          invalidSpecialtyValueArb,
          validTargetAudienceArb,
          async (name, phone, email, specialties, targetAudience) => {
            const { isValid, errorFields } = await validateDto({
              name,
              phone,
              email,
              specialties,
              targetAudience,
            });
            expect(isValid).toBe(false);
            expect(errorFields).toContain('specialties');
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Biconditional property: valid IFF all fields pass', () => {
    it('should accept if and only if name non-empty, phone 10-11 digits, email valid, specialties 1-20 from catalog', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(validClinicDtoArb, fc.record({
            name: fc.oneof(validNameArb, emptyNameArb),
            phone: fc.oneof(validPhoneArb, invalidPhoneArb),
            email: fc.oneof(validEmailArb, invalidEmailArb),
            specialties: fc.oneof(validSpecialtiesArb, emptySpecialtiesArb),
            targetAudience: validTargetAudienceArb,
          })),
          async (input) => {
            // @IsNotEmpty() rejects only '', null, undefined — not whitespace-only
            const nameValid = typeof input.name === 'string' && input.name !== '';
            const phoneValid = /^\d{10,11}$/.test(input.phone);
            const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) && input.email.length > 0;
            const specialtiesValid =
              Array.isArray(input.specialties) &&
              input.specialties.length >= 1 &&
              input.specialties.length <= 20 &&
              input.specialties.every((s: string) => SPECIALTIES_CATALOG.includes(s as any));
            const targetAudienceValid = typeof input.targetAudience === 'string' && input.targetAudience !== '';

            const shouldBeValid = nameValid && phoneValid && emailIsValid && specialtiesValid && targetAudienceValid;

            const { isValid } = await validateDto(input);

            if (shouldBeValid) {
              expect(isValid).toBe(true);
            } else {
              expect(isValid).toBe(false);
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});
