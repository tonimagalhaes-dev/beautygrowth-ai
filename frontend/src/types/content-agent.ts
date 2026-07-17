export type RedeSocial = 'instagram' | 'facebook' | 'tiktok';

export interface GenerateBriefing {
  tema: string;
  procedimento?: string;
  redesSociais: RedeSocial[];
  publicoAlvoOverride?: string;
  idioma?: string;
}

export interface SugestaoVisual {
  formato: string; // "1:1", "4:5", "1.91:1", "9:16"
  descricao: string;
}

export interface ContentAgentResult {
  executionId: string;
  status: 'draft' | 'guardrail_blocked' | 'error';
  version: number;
  legendas: Record<RedeSocial, string>;
  hashtags: string[];
  sugestoesVisuais: Record<RedeSocial, SugestaoVisual>;
  modeloUtilizado: string;
  usouFallback: boolean;
  tokensConsumidos: { input: number; output: number };
  duracaoMs: number;
  /** Indicates whether the response came from cache or was freshly generated */
  source?: 'cache' | 'generated';
  /** When true, the response is a similar match that requires user confirmation */
  confirmationRequired?: boolean;
  /** The cache entry ID for similar match confirmation flow */
  cacheEntryId?: string;
}

export interface RefineRequest {
  executionId: string;
  instrucoes: string;
}
