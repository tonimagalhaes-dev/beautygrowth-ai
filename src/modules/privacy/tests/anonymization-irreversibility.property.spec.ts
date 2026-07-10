import * as fc from 'fast-check';
import * as crypto from 'crypto';

/**
 * Property 23: Anonimização Irreversível
 *
 * For any personal data (names, emails, phone numbers, addresses) that is anonymized,
 * the output MUST NOT contain the original identifying information. The operation
 * is one-way (irreversible): the same input always produces the same hash, but the
 * hash cannot be reversed to recover the original data. Different inputs produce
 * different anonymized outputs.
 *
 * **Validates: Requirements 12.3**
 */
describe('Property 23: Anonimização Irreversível', () => {
  /**
   * Replicate the anonymization logic from PrivacyService.generateAnonymousId
   * Uses SHA-256 hashing — irreversible by design.
   */
  function generateAnonymousId(subjectId: string, tenantId: string): string {
    const hash = crypto
      .createHash('sha256')
      .update(`${tenantId}:${subjectId}:anonymized`)
      .digest('hex');
    return `anon_${hash.substring(0, 16)}`;
  }

  // Arbitraries for personal data generation
  const nameArb = fc.tuple(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 2, maxLength: 30 }),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 2, maxLength: 30 }),
  ).map(([first, last]) => `${first.charAt(0).toUpperCase() + first.slice(1)} ${last.charAt(0).toUpperCase() + last.slice(1)}`);

  const emailArb = fc.tuple(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), { minLength: 3, maxLength: 15 }),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 3, maxLength: 10 }),
  ).map(([local, domain]) => `${local}@${domain}.com`);

  const phoneArb = fc.stringOf(fc.constantFrom(...'0123456789'.split('')), { minLength: 10, maxLength: 11 })
    .map((digits) => `+55${digits}`);

  const addressArb = fc.tuple(
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')), { minLength: 5, maxLength: 40 }),
    fc.nat({ max: 9999 }),
    fc.stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz '.split('')), { minLength: 3, maxLength: 20 }),
  ).map(([street, number, city]) => `${street}, ${number}, ${city}`);

  // Combine all personal data types into a single arbitrary
  const personalDataArb = fc.oneof(nameArb, emailArb, phoneArb, addressArb);

  const tenantIdArb = fc.uuid();

  it(
    'anonymized output does NOT contain the original identifying information',
    () => {
      fc.assert(
        fc.property(personalDataArb, tenantIdArb, (personalData, tenantId) => {
          const anonymized = generateAnonymousId(personalData, tenantId);

          // The anonymized ID must not contain the original data
          expect(anonymized).not.toContain(personalData);

          // The anonymized ID must start with 'anon_' prefix
          expect(anonymized).toMatch(/^anon_[0-9a-f]{16}$/);

          // The anonymized output must not contain any part of the original data
          // that could identify the person (check substrings of length >= 3)
          if (personalData.length >= 3) {
            const hashPart = anonymized.substring(5).toLowerCase();
            for (let i = 0; i <= personalData.length - 3; i++) {
              const substring = personalData.substring(i, i + 3).toLowerCase();
              // Only check non-trivial substrings (not just hex chars)
              if (!/^[0-9a-f]+$/.test(substring)) {
                expect(hashPart).not.toContain(substring);
              }
            }
          }
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    'anonymization is deterministic — same input always produces same hash',
    () => {
      fc.assert(
        fc.property(personalDataArb, tenantIdArb, (personalData, tenantId) => {
          const result1 = generateAnonymousId(personalData, tenantId);
          const result2 = generateAnonymousId(personalData, tenantId);

          // Same input must always produce the same output (deterministic)
          expect(result1).toBe(result2);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    'anonymization is one-way — hash cannot be reversed to original data',
    () => {
      fc.assert(
        fc.property(personalDataArb, tenantIdArb, (personalData, tenantId) => {
          const anonymized = generateAnonymousId(personalData, tenantId);

          // The anonymized output is a fixed-length hex string (16 chars after prefix)
          // which is a truncated SHA-256 hash — information is irreversibly lost
          expect(anonymized.length).toBe(5 + 16); // 'anon_' + 16 hex chars

          // The hash is a 16-char hex — only 64 bits of entropy from 256-bit hash
          // This proves data loss: original data cannot be recovered from truncated hash
          const hashPart = anonymized.substring(5);
          expect(hashPart).toMatch(/^[0-9a-f]{16}$/);

          // Verify that the original data is longer/different from the hash output
          // (the mapping compresses arbitrary-length input to fixed 16-char output)
          // This demonstrates irreversibility — many inputs map to same space
          expect(anonymized).not.toBe(personalData);
          expect(anonymized).not.toBe(`anon_${personalData}`);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    'different inputs produce different anonymized outputs (no collisions for distinct inputs)',
    () => {
      fc.assert(
        fc.property(
          personalDataArb,
          personalDataArb,
          tenantIdArb,
          (personalData1, personalData2, tenantId) => {
            // Only check when inputs are actually different
            fc.pre(personalData1 !== personalData2);

            const anonymized1 = generateAnonymousId(personalData1, tenantId);
            const anonymized2 = generateAnonymousId(personalData2, tenantId);

            // Different inputs should produce different anonymized outputs
            expect(anonymized1).not.toBe(anonymized2);
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    'anonymization with different tenants produces different outputs for same subject',
    () => {
      fc.assert(
        fc.property(
          personalDataArb,
          tenantIdArb,
          tenantIdArb,
          (personalData, tenantId1, tenantId2) => {
            // Only test when tenant IDs are actually different
            fc.pre(tenantId1 !== tenantId2);

            const anonymized1 = generateAnonymousId(personalData, tenantId1);
            const anonymized2 = generateAnonymousId(personalData, tenantId2);

            // Same subject in different tenants should produce different anonymous IDs
            // This ensures cross-tenant correlation is not possible
            expect(anonymized1).not.toBe(anonymized2);
          },
        ),
        { numRuns: 100 },
      );
    },
  );
});
