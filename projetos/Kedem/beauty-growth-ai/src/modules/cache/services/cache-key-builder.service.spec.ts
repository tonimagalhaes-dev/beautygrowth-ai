import { CacheKeyBuilder } from './cache-key-builder.service';
import { InvalidTenantIdError } from '../errors/invalid-tenant-id.error';
import { CACHE_PREFIX } from '../config/cache.constants';

describe('CacheKeyBuilder', () => {
  let builder: CacheKeyBuilder;
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';

  beforeEach(() => {
    builder = new CacheKeyBuilder();
  });

  describe('prefix', () => {
    it('should use default prefix "beautygrowth:cache:"', () => {
      const key = builder.globalKey('resource', 'id');
      expect(key.startsWith(CACHE_PREFIX)).toBe(true);
      expect(key.startsWith('beautygrowth:cache:')).toBe(true);
    });

    it('should allow custom prefix via constructor', () => {
      const custom = new CacheKeyBuilder('custom:prefix:');
      const key = custom.globalKey('resource', 'id');
      expect(key.startsWith('custom:prefix:')).toBe(true);
    });
  });

  describe('tenantKey', () => {
    it('should build correct format with valid UUID', () => {
      const key = builder.tenantKey(validUuid, 'guardrails', 'active');
      expect(key).toBe(
        `beautygrowth:cache:tenant:${validUuid}:guardrails:active`,
      );
    });

    it('should include all segments in the correct order', () => {
      const key = builder.tenantKey(validUuid, 'prompts', 'template-1');
      const parts = key.split(':');
      expect(parts[0]).toBe('beautygrowth');
      expect(parts[1]).toBe('cache');
      expect(parts[2]).toBe('tenant');
      expect(parts[3]).toBe(validUuid);
      expect(parts[4]).toBe('prompts');
      expect(parts[5]).toBe('template-1');
    });

    it('should throw InvalidTenantIdError for invalid UUID', () => {
      expect(() => builder.tenantKey('invalid', 'res', 'id')).toThrow(
        InvalidTenantIdError,
      );
    });
  });

  describe('globalKey', () => {
    it('should build correct format', () => {
      const key = builder.globalKey('prompts', 'welcome');
      expect(key).toBe('beautygrowth:cache:global:prompts:welcome');
    });

    it('should not require tenant validation', () => {
      expect(() => builder.globalKey('resource', 'id')).not.toThrow();
    });
  });

  describe('tenantPattern', () => {
    it('should build correct glob pattern for tenant invalidation', () => {
      const pattern = builder.tenantPattern(validUuid);
      expect(pattern).toBe(`beautygrowth:cache:tenant:${validUuid}:*`);
    });

    it('should end with wildcard *', () => {
      const pattern = builder.tenantPattern(validUuid);
      expect(pattern.endsWith(':*')).toBe(true);
    });

    it('should throw InvalidTenantIdError for invalid UUID', () => {
      expect(() => builder.tenantPattern('bad-id')).toThrow(
        InvalidTenantIdError,
      );
    });
  });

  describe('tenantResourcePattern', () => {
    it('should build correct glob pattern for resource invalidation', () => {
      const pattern = builder.tenantResourcePattern(validUuid, 'guardrails');
      expect(pattern).toBe(
        `beautygrowth:cache:tenant:${validUuid}:guardrails:*`,
      );
    });

    it('should end with wildcard *', () => {
      const pattern = builder.tenantResourcePattern(validUuid, 'prompts');
      expect(pattern.endsWith(':*')).toBe(true);
    });

    it('should throw InvalidTenantIdError for invalid UUID', () => {
      expect(() =>
        builder.tenantResourcePattern('not-uuid', 'guardrails'),
      ).toThrow(InvalidTenantIdError);
    });
  });

  describe('validateTenantId', () => {
    it('should not throw for valid UUID v4', () => {
      expect(() => builder.validateTenantId(validUuid)).not.toThrow();
    });

    it('should not throw for uppercase UUID v4', () => {
      expect(() =>
        builder.validateTenantId('550E8400-E29B-41D4-A716-446655440000'),
      ).not.toThrow();
    });

    it('should throw InvalidTenantIdError for empty string', () => {
      expect(() => builder.validateTenantId('')).toThrow(InvalidTenantIdError);
    });

    it('should throw InvalidTenantIdError for "not-a-uuid"', () => {
      expect(() => builder.validateTenantId('not-a-uuid')).toThrow(
        InvalidTenantIdError,
      );
    });

    it('should throw InvalidTenantIdError for "123"', () => {
      expect(() => builder.validateTenantId('123')).toThrow(
        InvalidTenantIdError,
      );
    });

    it('should throw InvalidTenantIdError for "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"', () => {
      expect(() =>
        builder.validateTenantId('xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'),
      ).toThrow(InvalidTenantIdError);
    });

    it('should include the invalid tenantId in the error', () => {
      try {
        builder.validateTenantId('bad-id');
        fail('Expected InvalidTenantIdError');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidTenantIdError);
        expect((error as InvalidTenantIdError).tenantId).toBe('bad-id');
      }
    });
  });

  describe('all tenant methods throw on invalid UUID', () => {
    const invalidId = 'not-a-valid-uuid';

    it('tenantKey throws InvalidTenantIdError', () => {
      expect(() => builder.tenantKey(invalidId, 'res', 'id')).toThrow(
        InvalidTenantIdError,
      );
    });

    it('tenantPattern throws InvalidTenantIdError', () => {
      expect(() => builder.tenantPattern(invalidId)).toThrow(
        InvalidTenantIdError,
      );
    });

    it('tenantResourcePattern throws InvalidTenantIdError', () => {
      expect(() =>
        builder.tenantResourcePattern(invalidId, 'resource'),
      ).toThrow(InvalidTenantIdError);
    });
  });
});
