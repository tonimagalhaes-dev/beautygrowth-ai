import apiClient from '@/services/api';
import type {
  PaginatedCacheEntries,
  CacheEntryDetail,
  ConfirmSimilarMatchRequest,
  ContentAgentResponseWithMeta,
} from '@/types/prompt-cache';

export const promptCacheService = {
  listEntries: (params: { page: number; limit: number }): Promise<PaginatedCacheEntries> =>
    apiClient
      .get('/api/prompt-cache/entries', { params })
      .then((r) => r.data),

  getEntry: (id: string): Promise<CacheEntryDetail> =>
    apiClient.get(`/api/prompt-cache/entries/${id}`).then((r) => r.data),

  confirmSimilarMatch: (data: ConfirmSimilarMatchRequest): Promise<ContentAgentResponseWithMeta> =>
    apiClient.post('/api/prompt-cache/confirm-similar', data).then((r) => r.data),
};
