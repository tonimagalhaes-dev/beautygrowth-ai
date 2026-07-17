import { Test, TestingModule } from '@nestjs/testing';
import {
  PromptFingerprintService,
  FingerprintInput,
} from './prompt-fingerprint.service';

describe('PromptFingerprintService', () => {
  let service: PromptFingerprintService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PromptFingerprintService],
    }).compile();

    service = module.get<PromptFingerprintService>(PromptFingerprintService);
  });

  describe('computeFingerprint', () => {
    it('should return a 64-character hex string (SHA-256)', () => {
      const params: FingerprintInput = {
        tema: 'Botox facial',
        redesSociais: ['instagram'],
      };

      const fingerprint = service.computeFingerprint(params);

      expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should return the same fingerprint for identical inputs', () => {
      const params: FingerprintInput = {
        tema: 'Botox facial',
        procedimento: 'abc-uuid',
        publicoAlvoOverride: 'Mulheres 30-50',
        redesSociais: ['instagram', 'facebook'],
        idioma: 'pt-BR',
      };

      const fp1 = service.computeFingerprint(params);
      const fp2 = service.computeFingerprint(params);

      expect(fp1).toBe(fp2);
    });

    it('should produce the same fingerprint regardless of redesSociais order', () => {
      const params1: FingerprintInput = {
        tema: 'Harmonização facial',
        redesSociais: ['instagram', 'facebook', 'tiktok'],
      };
      const params2: FingerprintInput = {
        tema: 'Harmonização facial',
        redesSociais: ['tiktok', 'facebook', 'instagram'],
      };

      expect(service.computeFingerprint(params1)).toBe(
        service.computeFingerprint(params2),
      );
    });

    it('should produce the same fingerprint regardless of case differences', () => {
      const params1: FingerprintInput = {
        tema: 'Botox Facial',
        redesSociais: ['instagram'],
      };
      const params2: FingerprintInput = {
        tema: 'botox facial',
        redesSociais: ['instagram'],
      };

      expect(service.computeFingerprint(params1)).toBe(
        service.computeFingerprint(params2),
      );
    });

    it('should produce the same fingerprint regardless of extra whitespace', () => {
      const params1: FingerprintInput = {
        tema: '  Botox   facial  ',
        redesSociais: ['instagram'],
      };
      const params2: FingerprintInput = {
        tema: 'botox facial',
        redesSociais: ['instagram'],
      };

      expect(service.computeFingerprint(params1)).toBe(
        service.computeFingerprint(params2),
      );
    });

    it('should produce different fingerprints for different temas', () => {
      const params1: FingerprintInput = {
        tema: 'Botox facial',
        redesSociais: ['instagram'],
      };
      const params2: FingerprintInput = {
        tema: 'Preenchimento labial',
        redesSociais: ['instagram'],
      };

      expect(service.computeFingerprint(params1)).not.toBe(
        service.computeFingerprint(params2),
      );
    });

    it('should produce different fingerprints when procedimento differs', () => {
      const params1: FingerprintInput = {
        tema: 'Botox facial',
        procedimento: 'uuid-1',
        redesSociais: ['instagram'],
      };
      const params2: FingerprintInput = {
        tema: 'Botox facial',
        procedimento: 'uuid-2',
        redesSociais: ['instagram'],
      };

      expect(service.computeFingerprint(params1)).not.toBe(
        service.computeFingerprint(params2),
      );
    });

    it('should treat missing idioma as pt-BR', () => {
      const params1: FingerprintInput = {
        tema: 'Botox facial',
        redesSociais: ['instagram'],
      };
      const params2: FingerprintInput = {
        tema: 'Botox facial',
        redesSociais: ['instagram'],
        idioma: 'pt-BR',
      };

      expect(service.computeFingerprint(params1)).toBe(
        service.computeFingerprint(params2),
      );
    });

    it('should treat undefined procedimento and publicoAlvoOverride as null', () => {
      const params1: FingerprintInput = {
        tema: 'Botox',
        redesSociais: ['instagram'],
      };
      const params2: FingerprintInput = {
        tema: 'Botox',
        procedimento: undefined,
        publicoAlvoOverride: undefined,
        redesSociais: ['instagram'],
      };

      expect(service.computeFingerprint(params1)).toBe(
        service.computeFingerprint(params2),
      );
    });
  });

  describe('normalize', () => {
    it('should lowercase and trim tema', () => {
      const result = service.normalize({
        tema: '  BOTOX Facial  ',
        redesSociais: ['instagram'],
      });

      expect(result.tema).toBe('botox facial');
    });

    it('should collapse multiple whitespace in tema to single space', () => {
      const result = service.normalize({
        tema: 'botox    facial   treatment',
        redesSociais: ['instagram'],
      });

      expect(result.tema).toBe('botox facial treatment');
    });

    it('should handle tabs and newlines in tema', () => {
      const result = service.normalize({
        tema: 'botox\tfacial\ntreatment',
        redesSociais: ['instagram'],
      });

      expect(result.tema).toBe('botox facial treatment');
    });

    it('should lowercase procedimento or set null', () => {
      const withProcedimento = service.normalize({
        tema: 'test',
        procedimento: 'ABC-UUID',
        redesSociais: [],
      });
      expect(withProcedimento.procedimento).toBe('abc-uuid');

      const withoutProcedimento = service.normalize({
        tema: 'test',
        redesSociais: [],
      });
      expect(withoutProcedimento.procedimento).toBeNull();
    });

    it('should normalize publicoAlvoOverride or set null', () => {
      const withOverride = service.normalize({
        tema: 'test',
        publicoAlvoOverride: '  MULHERES   30-50  ',
        redesSociais: [],
      });
      expect(withOverride.publicoAlvoOverride).toBe('mulheres 30-50');

      const withoutOverride = service.normalize({
        tema: 'test',
        redesSociais: [],
      });
      expect(withoutOverride.publicoAlvoOverride).toBeNull();
    });

    it('should sort redesSociais alphabetically', () => {
      const result = service.normalize({
        tema: 'test',
        redesSociais: ['tiktok', 'facebook', 'instagram'],
      });

      expect(result.redesSociais).toEqual(['facebook', 'instagram', 'tiktok']);
    });

    it('should not mutate the original redesSociais array', () => {
      const original = ['tiktok', 'facebook', 'instagram'];
      service.normalize({
        tema: 'test',
        redesSociais: original,
      });

      expect(original).toEqual(['tiktok', 'facebook', 'instagram']);
    });

    it('should default idioma to pt-br (lowercased)', () => {
      const result = service.normalize({
        tema: 'test',
        redesSociais: [],
      });

      expect(result.idioma).toBe('pt-br');
    });

    it('should lowercase provided idioma', () => {
      const result = service.normalize({
        tema: 'test',
        redesSociais: [],
        idioma: 'EN-US',
      });

      expect(result.idioma).toBe('en-us');
    });

    it('should handle empty redesSociais array', () => {
      const result = service.normalize({
        tema: 'test',
        redesSociais: [],
      });

      expect(result.redesSociais).toEqual([]);
    });

    it('should handle empty string publicoAlvoOverride as null', () => {
      const result = service.normalize({
        tema: 'test',
        publicoAlvoOverride: '',
        redesSociais: [],
      });

      // Empty string is falsy, so it should be treated as null
      expect(result.publicoAlvoOverride).toBeNull();
    });
  });

  describe('getNormalizedTema', () => {
    it('should lowercase the tema', () => {
      expect(service.getNormalizedTema('BOTOX FACIAL')).toBe('botox facial');
    });

    it('should trim leading and trailing whitespace', () => {
      expect(service.getNormalizedTema('  botox facial  ')).toBe(
        'botox facial',
      );
    });

    it('should collapse multiple spaces into one', () => {
      expect(service.getNormalizedTema('botox    facial')).toBe(
        'botox facial',
      );
    });

    it('should handle mixed case, whitespace, and trimming', () => {
      expect(
        service.getNormalizedTema('  BOTOX   Facial   TREATMENT  '),
      ).toBe('botox facial treatment');
    });

    it('should handle single word', () => {
      expect(service.getNormalizedTema('Botox')).toBe('botox');
    });

    it('should handle unicode characters', () => {
      expect(
        service.getNormalizedTema('  Harmonização   FACIAL  '),
      ).toBe('harmonização facial');
    });
  });
});
