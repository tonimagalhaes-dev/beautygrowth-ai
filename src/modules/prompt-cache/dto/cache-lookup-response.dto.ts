import { ContentAgentResponse } from '../../content-agent/dto/content-agent-response.dto';
import { ContentAgentResponseWithMeta } from '../interfaces/prompt-cache.interface';

/**
 * Response DTO for cache lookup operations that includes source metadata.
 * Extends the standard ContentAgentResponse with cache-specific fields.
 *
 * Note: The canonical `ContentAgentResponseWithMeta` interface is defined
 * in `../interfaces/prompt-cache.interface.ts` — re-exported here for convenience.
 */
export class CacheLookupResponseDto implements ContentAgentResponseWithMeta {
  executionId: string;
  status: 'draft' | 'guardrail_blocked' | 'error';
  version: number;
  legendas: Record<string, string>;
  hashtags: string[];
  sugestoesVisuais: Record<string, { formato: string; descricao: string }>;
  modeloUtilizado: string;
  usouFallback: boolean;
  tokensConsumidos: { input: number; output: number };
  duracaoMs: number;
  source: 'cache' | 'generated';
  confirmationRequired?: boolean;
  cacheEntryId?: string;
}

export { ContentAgentResponseWithMeta } from '../interfaces/prompt-cache.interface';

