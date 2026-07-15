import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { GenerateImageDto } from './generate-image.dto';

describe('GenerateImageDto', () => {
  function createDto(partial: Partial<Record<string, unknown>>): GenerateImageDto {
    return plainToInstance(GenerateImageDto, partial);
  }

  describe('valid payloads', () => {
    it('should accept a valid payload with all required fields', async () => {
      const dto = createDto({
        descricaoVisual: 'Imagem elegante de harmonização facial em clínica',
        redesSociais: ['instagram'],
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should accept a valid payload with all optional fields', async () => {
      const dto = createDto({
        descricaoVisual: 'Imagem elegante de harmonização facial em clínica',
        redesSociais: ['instagram', 'facebook', 'tiktok'],
        contentExecutionId: '550e8400-e29b-41d4-a716-446655440000',
        aplicarLogoOverlay: true,
        estiloVisualAdicional: 'minimalista, tons pastéis',
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should accept descricaoVisual with exactly 10 chars', async () => {
      const dto = createDto({
        descricaoVisual: 'abcdefghij', // exactly 10 chars
        redesSociais: ['facebook'],
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });

    it('should accept descricaoVisual with exactly 1000 chars', async () => {
      const dto = createDto({
        descricaoVisual: 'a'.repeat(1000),
        redesSociais: ['tiktok'],
      });

      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    });
  });

  describe('descricaoVisual validation (Req 1.2, 1.3)', () => {
    it('should reject when descricaoVisual is missing', async () => {
      const dto = createDto({
        redesSociais: ['instagram'],
      });

      const errors = await validate(dto);
      expect(errors.length).toBeGreaterThan(0);
      const descricaoError = errors.find((e) => e.property === 'descricaoVisual');
      expect(descricaoError).toBeDefined();
    });

    it('should reject when descricaoVisual has less than 10 chars', async () => {
      const dto = createDto({
        descricaoVisual: 'curta',
        redesSociais: ['instagram'],
      });

      const errors = await validate(dto);
      const descricaoError = errors.find((e) => e.property === 'descricaoVisual');
      expect(descricaoError).toBeDefined();
      expect(descricaoError!.constraints).toHaveProperty('minLength');
    });

    it('should reject when descricaoVisual is whitespace-padded and trimmed result < 10 chars', async () => {
      const dto = createDto({
        descricaoVisual: '   curta   ', // "curta" = 5 chars after trim
        redesSociais: ['instagram'],
      });

      const errors = await validate(dto);
      const descricaoError = errors.find((e) => e.property === 'descricaoVisual');
      expect(descricaoError).toBeDefined();
      expect(descricaoError!.constraints).toHaveProperty('minLength');
    });

    it('should reject when descricaoVisual exceeds 1000 chars', async () => {
      const dto = createDto({
        descricaoVisual: 'a'.repeat(1001),
        redesSociais: ['instagram'],
      });

      const errors = await validate(dto);
      const descricaoError = errors.find((e) => e.property === 'descricaoVisual');
      expect(descricaoError).toBeDefined();
      expect(descricaoError!.constraints).toHaveProperty('maxLength');
    });
  });

  describe('redesSociais validation (Req 1.2, 1.4)', () => {
    it('should reject when redesSociais is missing', async () => {
      const dto = createDto({
        descricaoVisual: 'Imagem elegante de harmonização facial em clínica',
      });

      const errors = await validate(dto);
      const redesError = errors.find((e) => e.property === 'redesSociais');
      expect(redesError).toBeDefined();
    });

    it('should reject when redesSociais is empty array', async () => {
      const dto = createDto({
        descricaoVisual: 'Imagem elegante de harmonização facial em clínica',
        redesSociais: [],
      });

      const errors = await validate(dto);
      const redesError = errors.find((e) => e.property === 'redesSociais');
      expect(redesError).toBeDefined();
      expect(redesError!.constraints).toHaveProperty('arrayMinSize');
    });

    it('should reject when redesSociais has more than 3 values', async () => {
      const dto = createDto({
        descricaoVisual: 'Imagem elegante de harmonização facial em clínica',
        redesSociais: ['instagram', 'facebook', 'tiktok', 'instagram'],
      });

      const errors = await validate(dto);
      const redesError = errors.find((e) => e.property === 'redesSociais');
      expect(redesError).toBeDefined();
      expect(redesError!.constraints).toHaveProperty('arrayMaxSize');
    });

    it('should reject when redesSociais contains invalid value', async () => {
      const dto = createDto({
        descricaoVisual: 'Imagem elegante de harmonização facial em clínica',
        redesSociais: ['twitter'],
      });

      const errors = await validate(dto);
      const redesError = errors.find((e) => e.property === 'redesSociais');
      expect(redesError).toBeDefined();
      expect(redesError!.constraints).toHaveProperty('isIn');
    });
  });

  describe('estiloVisualAdicional validation (Req 1.3)', () => {
    it('should reject when estiloVisualAdicional exceeds 300 chars', async () => {
      const dto = createDto({
        descricaoVisual: 'Imagem elegante de harmonização facial em clínica',
        redesSociais: ['instagram'],
        estiloVisualAdicional: 'x'.repeat(301),
      });

      const errors = await validate(dto);
      const estiloError = errors.find((e) => e.property === 'estiloVisualAdicional');
      expect(estiloError).toBeDefined();
      expect(estiloError!.constraints).toHaveProperty('maxLength');
    });
  });
});
