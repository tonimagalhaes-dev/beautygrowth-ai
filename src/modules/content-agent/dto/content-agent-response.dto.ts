import { RedeSocial } from './generate-briefing.dto';

export interface SugestaoVisual {
  formato: string;
  descricao: string;
}

export interface ContentAgentResponse {
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
}
