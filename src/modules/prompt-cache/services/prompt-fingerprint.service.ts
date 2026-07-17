import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

export interface FingerprintInput {
  tema: string;
  procedimento?: string;
  publicoAlvoOverride?: string;
  redesSociais: string[];
  idioma?: string;
}

export interface NormalizedFingerprint {
  tema: string;
  procedimento: string | null;
  publicoAlvoOverride: string | null;
  redesSociais: string[];
  idioma: string;
}

/**
 * PromptFingerprintService computes deterministic SHA-256 fingerprints
 * from normalized prompt parameters for exact-match cache lookups.
 *
 * Normalization ensures that semantically equivalent prompts
 * produce the same hash regardless of formatting differences.
 */
@Injectable()
export class PromptFingerprintService {
  /**
   * Computes a SHA-256 fingerprint from normalized prompt parameters.
   * Normalization ensures that semantically equivalent prompts
   * produce the same hash regardless of formatting differences.
   */
  computeFingerprint(params: FingerprintInput): string {
    const normalized = this.normalize(params);
    const payload = JSON.stringify(normalized);
    return createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Normalizes prompt parameters for consistent hashing:
   * 1. tema: lowercase, trim, collapse whitespace
   * 2. procedimento: lowercase or null
   * 3. publicoAlvoOverride: lowercase, trim, collapse whitespace or null
   * 4. redesSociais: sorted alphabetically
   * 5. idioma: lowercase (defaults to 'pt-BR' if not provided)
   */
  normalize(params: FingerprintInput): NormalizedFingerprint {
    return {
      tema: this.normalizeText(params.tema),
      procedimento: params.procedimento?.toLowerCase() ?? null,
      publicoAlvoOverride: params.publicoAlvoOverride
        ? this.normalizeText(params.publicoAlvoOverride)
        : null,
      redesSociais: [...params.redesSociais].sort(),
      idioma: (params.idioma ?? 'pt-BR').toLowerCase(),
    };
  }

  /**
   * Returns the normalized tema text for similar match comparison.
   */
  getNormalizedTema(tema: string): string {
    return this.normalizeText(tema);
  }

  private normalizeText(text: string): string {
    return text.toLowerCase().trim().replace(/\s+/g, ' ');
  }
}
