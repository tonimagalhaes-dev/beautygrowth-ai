import type { RedeSocial } from '@/types/content-agent';

// === Status Types ===

export type DesignerAgentStatus = 'processing' | 'generated' | 'guardrail_blocked' | 'error';

export type DesignerAgentState = 'idle' | 'processing' | 'generated' | 'error';

// === Request Types ===

export interface GenerateFromContentRequest {
  contentExecutionId: string;
  aplicarLogoOverlay?: boolean;
  estiloVisualAdicional?: string;
}

// === Response Types ===

export interface GenerateAcceptedResponse {
  executionId: string;
  status: 'processing';
}

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

export interface DesignerAgentExecution {
  executionId: string;
  status: DesignerAgentStatus;
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

// === Hook Return Type ===

export interface UseDesignerAgentReturn {
  state: DesignerAgentState;
  result: DesignerAgentExecution | null;
  triggerGeneration: (contentExecutionId: string) => void;
  isGenerating: boolean;
  error: string | null;
  reset: () => void;
}
