import { PromptCacheEntry } from '../entities/prompt-cache-entry.entity';
import { ContentAgentResponse } from '../../content-agent/dto/content-agent-response.dto';

export interface CacheLookupResult {
  type: 'exact_match' | 'similar_match' | 'miss';
  entry?: PromptCacheEntry;
  source?: 'cache' | 'generated';
  tokensConsumed?: { input: number; output: number };
  confirmationRequired?: boolean;
}

export interface PaginatedCacheEntries {
  data: CacheEntryPreview[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface CacheEntryPreview {
  id: string;
  tema: string;
  redesSociais: string[];
  createdAt: string;
  contentPreview: string;
  hasImages: boolean;
}

export interface CacheEntryDetailResponse {
  id: string;
  executionId: string;
  tema: string;
  procedimento: string | null;
  publicoAlvoOverride: string | null;
  redesSociais: string[];
  idioma: string;
  responsePayload: ContentAgentResponse;
  imageReferences: Array<{ imageId: string; url: string; redeSocial: string }>;
  createdAt: string;
}

export interface ConfirmSimilarMatchDto {
  cacheEntryId: string;
  confirmed: boolean;
}

export interface ContentAgentResponseWithMeta extends ContentAgentResponse {
  source: 'cache' | 'generated';
  confirmationRequired?: boolean;
  cacheEntryId?: string;
}
