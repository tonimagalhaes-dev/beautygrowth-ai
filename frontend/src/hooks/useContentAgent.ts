import { useState, useMemo, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { toast } from 'sonner';
import { contentAgentService } from '@/services/content-agent.service';
import { promptCacheService } from '@/services/promptCacheService';
import type { GenerateBriefing, ContentAgentResult, RefineRequest } from '@/types/content-agent';

export interface UseContentAgentReturn {
  generate: ReturnType<typeof useMutation<ContentAgentResult, Error, GenerateBriefing>>;
  refine: ReturnType<typeof useMutation<ContentAgentResult, Error, RefineRequest>>;
  currentResult: ContentAgentResult | null;
  refinementCount: number;
  isAtRefinementLimit: boolean;
  resetResult: () => void;
  /** The cached result awaiting user confirmation (similar match) */
  similarMatch: ContentAgentResult | null;
  /** Confirms reuse of the similar match */
  confirmSimilar: () => void;
  /** Dismisses the similar match and triggers a fresh generation */
  dismissSimilar: () => void;
  /** Loads a cached result directly into the result panel */
  loadCachedResult: (result: ContentAgentResult) => void;
}

export function useContentAgent(): UseContentAgentReturn {
  const [currentResult, setCurrentResult] = useState<ContentAgentResult | null>(null);
  const [similarMatch, setSimilarMatch] = useState<ContentAgentResult | null>(null);
  const [lastBriefing, setLastBriefing] = useState<GenerateBriefing | null>(null);

  const generate = useMutation<ContentAgentResult, Error, GenerateBriefing>({
    mutationFn: (data) => {
      setLastBriefing(data);
      return contentAgentService.generate(data);
    },
    onSuccess: (result) => {
      if (result.confirmationRequired && result.cacheEntryId) {
        setSimilarMatch(result);
      } else {
        setCurrentResult(result);
      }
    },
  });

  const refine = useMutation<ContentAgentResult, Error, RefineRequest>({
    mutationFn: (data) => contentAgentService.refine(data),
    onSuccess: (result) => {
      setCurrentResult(result);
    },
    onError: (error) => {
      if (error instanceof AxiosError && error.response?.status === 429) {
        toast.error('Limite de refinamentos atingido. Não é possível refinar mais esta execução.');
      }
    },
  });

  const confirmSimilar = useCallback(() => {
    if (!similarMatch?.cacheEntryId) return;

    promptCacheService
      .confirmSimilarMatch({ cacheEntryId: similarMatch.cacheEntryId, confirmed: true })
      .then((result) => {
        setCurrentResult(result);
        setSimilarMatch(null);
      })
      .catch(() => {
        toast.error('Erro ao confirmar resultado similar. Tente novamente.');
      });
  }, [similarMatch]);

  const dismissSimilar = useCallback(() => {
    const cachedEntryId = similarMatch?.cacheEntryId;
    setSimilarMatch(null);

    // Notify backend that the similar match was declined (fire-and-forget)
    if (cachedEntryId) {
      promptCacheService
        .confirmSimilarMatch({ cacheEntryId: cachedEntryId, confirmed: false })
        .catch(() => { /* ignore - non-blocking */ });
    }

    // Re-trigger fresh generation with the last briefing (Requirement 3.4)
    if (lastBriefing) {
      generate.mutate(lastBriefing);
    }
  }, [lastBriefing, similarMatch, generate]);

  const refinementCount = useMemo(
    () => (currentResult ? currentResult.version - 1 : 0),
    [currentResult],
  );

  const isAtRefinementLimit = useMemo(
    () => (currentResult ? currentResult.version >= 6 : false),
    [currentResult],
  );

  const resetResult = () => {
    setCurrentResult(null);
    setSimilarMatch(null);
  };

  const loadCachedResult = useCallback((result: ContentAgentResult) => {
    setCurrentResult(result);
  }, []);

  return {
    generate,
    refine,
    currentResult,
    refinementCount,
    isAtRefinementLimit,
    resetResult,
    similarMatch,
    confirmSimilar,
    dismissSimilar,
    loadCachedResult,
  };
}
