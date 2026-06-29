import * as fc from 'fast-check';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RegisterDto } from '../dto/register.dto';

/**
 * Property 4: Validação de Senha
 *
 * For any random string candidate as password, the validation MUST accept
 * if and only if the string has: minimum 8 characters, at least 1 uppercase letter,
 * 1 lowercase letter, 1 number, and 1 special character.
 * Strings that don't meet any criterion MUST be rejected.
 *
 * **Validates: Requirements 3.1**
 */

// Standalone password validator that matches the regex used in RegisterDto
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z\d\s]).{8,}$/;

function isValidPassword(password: string): boolean {
  return PASSWORD_REGEX.test(password);
}

// Helper to validate RegisterDto password field via class-validator
async function validatePasswordWithDto(password: string): Promise<boolean> {
  const dto = plainToInstance(RegisterDto, {
    email: 'test@example.com',
    password,
    clinicName: 'Test Clinic',
  });
  const errors = await validate(dto);
  const passwordErrors = errors.filter((e) => e.property === 'password');
  return passwordErrors.length === 0;
}

// Arbitraries for generating valid passwords
const UPPERCASE = fc.char().filter((c) => /[A-Z]/.test(c));
const LOWERCASE = fc.char().filter((c) => /[a-z]/.test(c));
const DIGIT = fc.char().filter((c) => /\d/.test(c));
const SPECIAL = fc.constantFrom(
  '!', '@', '#', '$', '%', '^', '&', '*', '(', ')',
  '-', '_', '=', '+', '[', ']', '{', '}', '|', '\\',
  ';', ':', "'", '"', ',', '.', '<', '>', '/', '?', '~', '`',
);

// Generates a valid password (guaranteed to have all criteria)
const validPasswordArb = fc
  .tuple(
    UPPERCASE,
    LOWERCASE,
    DIGIT,
    SPECIAL,
    // Fill remaining chars to reach at least 8 total (need 4 more minimum)
    fc.array(
      fc.oneof(UPPERCASE, LOWERCASE, DIGIT, SPECIAL),
      { minLength: 4, maxLength: 20 },
    ),
  )
  .map(([upper, lower, digit, special, rest]) => {
    const chars = [upper, lower, digit, special, ...rest];
    // Shuffle to avoid predictable ordering
    for (let i = chars.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  });

// Generates strings that are too short (< 8 chars)
const tooShortArb = fc.string({ minLength: 0, maxLength: 7 });

// Generates strings missing uppercase
const noUppercaseArb = fc
  .stringOf(
    fc.char().filter((c) => !/[A-Z]/.test(c) && !/\s/.test(c)),
    { minLength: 8, maxLength: 30 },
  )
  .filter((s) => /[a-z]/.test(s) && /\d/.test(s) && /[^a-zA-Z\d\s]/.test(s));

// Generates strings missing lowercase
const noLowercaseArb = fc
  .stringOf(
    fc.char().filter((c) => !/[a-z]/.test(c) && !/\s/.test(c)),
    { minLength: 8, maxLength: 30 },
  )
  .filter((s) => /[A-Z]/.test(s) && /\d/.test(s) && /[^a-zA-Z\d\s]/.test(s));

// Generates strings missing digits
const noDigitArb = fc
  .stringOf(
    fc.char().filter((c) => !/\d/.test(c) && !/\s/.test(c)),
    { minLength: 8, maxLength: 30 },
  )
  .filter((s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /[^a-zA-Z\d\s]/.test(s));

// Generates strings missing special characters (only alphanumeric)
const noSpecialArb = fc
  .stringOf(fc.char().filter((c) => /[a-zA-Z\d]/.test(c)), {
    minLength: 8,
    maxLength: 30,
  })
  .filter((s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s));

describe('Property 4: Validação de Senha', () => {
  describe('Standalone validator function', () => {
    it('should accept all valid passwords (8+ chars, 1 upper, 1 lower, 1 digit, 1 special)', () => {
      fc.assert(
        fc.property(validPasswordArb, (password) => {
          expect(isValidPassword(password)).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('should reject passwords that are too short (< 8 chars)', () => {
      fc.assert(
        fc.property(tooShortArb, (password) => {
          expect(isValidPassword(password)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('should reject passwords missing uppercase letter', () => {
      fc.assert(
        fc.property(noUppercaseArb, (password) => {
          expect(isValidPassword(password)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('should reject passwords missing lowercase letter', () => {
      fc.assert(
        fc.property(noLowercaseArb, (password) => {
          expect(isValidPassword(password)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('should reject passwords missing digit', () => {
      fc.assert(
        fc.property(noDigitArb, (password) => {
          expect(isValidPassword(password)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('should reject passwords missing special character', () => {
      fc.assert(
        fc.property(noSpecialArb, (password) => {
          expect(isValidPassword(password)).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('should accept if and only if all criteria are met (biconditional property)', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 40 }),
          (candidate) => {
            const hasMinLength = candidate.length >= 8;
            const hasUpper = /[A-Z]/.test(candidate);
            const hasLower = /[a-z]/.test(candidate);
            const hasDigit = /\d/.test(candidate);
            const hasSpecial = /[^a-zA-Z\d\s]/.test(candidate);

            const shouldBeValid =
              hasMinLength && hasUpper && hasLower && hasDigit && hasSpecial;

            expect(isValidPassword(candidate)).toBe(shouldBeValid);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  describe('RegisterDto class-validator integration', () => {
    it('should accept valid passwords through DTO validation', async () => {
      await fc.assert(
        fc.asyncProperty(validPasswordArb, async (password) => {
          const isValid = await validatePasswordWithDto(password);
          expect(isValid).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    it('should reject passwords too short through DTO validation', async () => {
      await fc.assert(
        fc.asyncProperty(tooShortArb, async (password) => {
          const isValid = await validatePasswordWithDto(password);
          expect(isValid).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('should reject passwords missing criteria through DTO validation', async () => {
      await fc.assert(
        fc.asyncProperty(noSpecialArb, async (password) => {
          const isValid = await validatePasswordWithDto(password);
          expect(isValid).toBe(false);
        }),
        { numRuns: 100 },
      );
    });

    it('DTO validation matches standalone validator for any input (biconditional)', async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 40 }),
          async (candidate) => {
            const standaloneResult = isValidPassword(candidate);
            const dtoResult = await validatePasswordWithDto(candidate);
            expect(dtoResult).toBe(standaloneResult);
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  describe('Edge cases', () => {
    it('should handle exactly 8 character valid passwords', () => {
      fc.assert(
        fc.property(
          fc.tuple(UPPERCASE, LOWERCASE, DIGIT, SPECIAL, fc.array(
            fc.oneof(UPPERCASE, LOWERCASE, DIGIT, SPECIAL),
            { minLength: 4, maxLength: 4 },
          )),
          ([upper, lower, digit, special, rest]) => {
            const chars = [upper, lower, digit, special, ...rest];
            const password = chars.join('');
            expect(password.length).toBe(8);
            expect(isValidPassword(password)).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });

    it('should handle very long valid passwords', () => {
      fc.assert(
        fc.property(
          fc.tuple(
            UPPERCASE,
            LOWERCASE,
            DIGIT,
            SPECIAL,
            fc.array(
              fc.oneof(UPPERCASE, LOWERCASE, DIGIT, SPECIAL),
              { minLength: 96, maxLength: 124 },
            ),
          ),
          ([upper, lower, digit, special, rest]) => {
            const password = [upper, lower, digit, special, ...rest].join('');
            expect(password.length).toBeGreaterThanOrEqual(100);
            expect(isValidPassword(password)).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('should reject passwords with only spaces (whitespace)', () => {
      fc.assert(
        fc.property(
          fc.stringOf(fc.constant(' '), { minLength: 8, maxLength: 20 }),
          (password) => {
            expect(isValidPassword(password)).toBe(false);
          },
        ),
        { numRuns: 50 },
      );
    });

    it('should handle unicode characters in passwords', () => {
      fc.assert(
        fc.property(
          fc.tuple(UPPERCASE, LOWERCASE, DIGIT, SPECIAL, fc.array(
            fc.oneof(
              fc.fullUnicode().filter((c) => !/\s/.test(c)),
              UPPERCASE,
              LOWERCASE,
            ),
            { minLength: 4, maxLength: 10 },
          )),
          ([upper, lower, digit, special, rest]) => {
            const password = [upper, lower, digit, special, ...rest].join('');
            // With unicode, the password should still pass if all ASCII criteria are met
            const hasMinLength = password.length >= 8;
            const hasUpper = /[A-Z]/.test(password);
            const hasLower = /[a-z]/.test(password);
            const hasDigit = /\d/.test(password);
            const hasSpecial = /[^a-zA-Z\d\s]/.test(password);
            const expected =
              hasMinLength && hasUpper && hasLower && hasDigit && hasSpecial;
            expect(isValidPassword(password)).toBe(expected);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
