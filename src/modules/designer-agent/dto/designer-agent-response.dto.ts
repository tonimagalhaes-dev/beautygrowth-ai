import { RedeSocial } from './generate-image.dto';

export interface ImageResult {
  url: string;
  urlThumbnail: string;
  urlSemOverlay?: string;
  redeSocial: RedeSocial;
  aspectoRatio: string;
  tamanhoBytes: number;
  status: 'generated' | 'error';
  erroDetalhe?: string;
}

export interface DesignerAgentResponse {
  executionId: string;
  status: 'processing' | 'generated' | 'guardrail_blocked' | 'error';
  contentExecutionId?: string;
  images: Record<RedeSocial, ImageResult>;
  modeloUtilizado: string;
  usouFallback: boolean;
  tokensConsumidos: number;
  duracaoMs: number;
  version: number;
  logoOverlayAplicado: boolean;
  warnings: string[];
}

export interface GenerateAcceptedResponse {
  executionId: string;
  status: 'processing';
}
