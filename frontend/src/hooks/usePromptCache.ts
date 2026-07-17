import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { promptCacheService } from '@/services/promptCacheService';
import type {
  PaginatedCacheEntries,
  CacheEntryDetail,
  ConfirmSimilarMatchRequest,
  ContentAgentResponseWithMeta,
} from '@/types/prompt-cache';

export function usePromptCache() {
  const entries = useInfiniteQuery<PaginatedCacheEntries>({
    queryKey: ['prompt-cache', 'entries'],
    queryFn: ({ pageParam = 1 }) =>
      promptCacheService.listEntries({ page: pageParam as number, limit: 20 }),
    getNextPageParam: (lastPage) =>
      lastPage.hasMore ? lastPage.page + 1 : undefined,
    initialPageParam: 1,
  });

  const confirmSimilar = useMutation<
    ContentAgentResponseWithMeta,
    Error,
    ConfirmSimilarMatchRequest
  >({
    mutationFn: (data) => promptCacheService.confirmSimilarMatch(data),
  });

  const getEntry = useMutation<CacheEntryDetail, Error, string>({
    mutationFn: (id) => promptCacheService.getEntry(id),
  });

  return { entries, confirmSimilar, getEntry };
}
