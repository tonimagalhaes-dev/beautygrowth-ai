import { PayloadValidator } from './payload-validator.service';

describe('PayloadValidator', () => {
  let validator: PayloadValidator;

  beforeEach(() => {
    validator = new PayloadValidator();
  });

  describe('validatePayload', () => {
    it('should pass validation for a valid tenant.created payload', async () => {
      const payload = {
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
      };

      await expect(
        validator.validatePayload('tenant.created', payload),
      ).resolves.toBeUndefined();
    });

    it('should pass validation for a valid brand.updated payload', async () => {
      const payload = {
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
        brandId: '660e8400-e29b-41d4-a716-446655440000',
        action: 'updated',
      };

      await expect(
        validator.validatePayload('brand.updated', payload),
      ).resolves.toBeUndefined();
    });

    it('should throw when tenantId is missing (Req 5.1)', async () => {
      const payload = {};

      await expect(
        validator.validatePayload('tenant.created', payload),
      ).rejects.toThrow(/Payload validation failed.*tenant\.created/);
    });

    it('should throw when tenantId is not a valid UUID (Req 5.1)', async () => {
      const payload = { tenantId: 'not-a-uuid' };

      await expect(
        validator.validatePayload('tenant.created', payload),
      ).rejects.toThrow(/Payload validation failed.*tenant\.created/);
    });

    it('should list invalid fields in error message (Req 9.3)', async () => {
      const payload = { tenantId: 'invalid' };

      try {
        await validator.validatePayload('tenant.created', payload);
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('tenantId');
      }
    });

    it('should throw for unknown event names', async () => {
      const payload = { tenantId: '550e8400-e29b-41d4-a716-446655440000' };

      await expect(
        validator.validatePayload('unknown.event', payload),
      ).rejects.toThrow("Event 'unknown.event' not found in registry");
    });

    it('should throw with descriptive error for multiple invalid fields', async () => {
      const payload = {
        tenantId: 'invalid-uuid',
        brandId: 'also-invalid',
        action: 'invalid-action',
      };

      try {
        await validator.validatePayload('brand.updated', payload);
        fail('Should have thrown');
      } catch (error) {
        expect((error as Error).message).toContain('tenantId');
        expect((error as Error).message).toContain('brandId');
        expect((error as Error).message).toContain('action');
      }
    });

    it('should ignore extra properties with whitelist: true', async () => {
      const payload = {
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
        extraField: 'should be ignored',
      };

      await expect(
        validator.validatePayload('tenant.created', payload),
      ).resolves.toBeUndefined();
    });

    it('should validate guardrails.changed payload correctly', async () => {
      const validPayload = {
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
        guardrailId: '770e8400-e29b-41d4-a716-446655440000',
        action: 'created',
      };

      await expect(
        validator.validatePayload('guardrails.changed', validPayload),
      ).resolves.toBeUndefined();
    });

    it('should validate guardrails.violation payload correctly', async () => {
      const validPayload = {
        tenantId: '550e8400-e29b-41d4-a716-446655440000',
        agentId: '880e8400-e29b-41d4-a716-446655440000',
        guardrailName: 'no-medical-claims',
        violationType: 'content-policy',
      };

      await expect(
        validator.validatePayload('guardrails.violation', validPayload),
      ).resolves.toBeUndefined();
    });
  });
});
