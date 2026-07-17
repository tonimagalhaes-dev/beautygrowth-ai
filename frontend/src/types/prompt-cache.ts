import type { ContentAgentResult } from '@/types/content-agent';

export interface CacheEntryPreview {
  id: string;
  tema: string;
  redesSociais: string[];
  createdAt: string;
  contentPreview: string;
  hasImages: boolean;
}

export interface PaginatedCacheEntries {
  data: CacheEntryPreview[];
  page: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface CacheEntryDetail {
  id: string;
  executionId: string;
  tema: string;
  procedimento: string | null;
  publicoAlvoOverride: string | null;
  redesSociais: string[];
  idioma: string;
  responsePayload: ContentAgentResult;
  imageReferences: Array<{ imageId: string; url: string; redeSocial: string }>;
  createdAt: string;
}

export interface ConfirmSimilarMatchRequest {
  cacheEntryId: string;
  confirmed: boolean;
}

export interface ContentAgentResponseWithMeta extends ContentAgentResult {
  source: 'cache' | 'generated';
  confirmationRequired?: boolean;
  cacheEntryId?: string;
}
