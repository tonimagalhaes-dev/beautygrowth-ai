import { useState, useMemo } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { toast } from 'sonner';
import { contentAgentService } from '@/services/content-agent.service';
import type { GenerateBriefing, ContentAgentResult, RefineRequest } from '@/types/content-agent';

export interface UseContentAgentReturn {
  generate: ReturnType<typeof useMutation<ContentAgentResult, Error, GenerateBriefing>>;
  refine: ReturnType<typeof useMutation<ContentAgentResult, Error, RefineRequest>>;
  currentResult: ContentAgentResult | null;
  refinementCount: number;
  isAtRefinementLimit: boolean;
  resetResult: () => void;
}

export function useContentAgent(): UseContentAgentReturn {
  const [currentResult, setCurrentResult] = useState<ContentAgentResult | null>(null);

  const generate = useMutation<ContentAgentResult, Error, GenerateBriefing>({
    mutationFn: (data) => contentAgentService.generate(data),
    onSuccess: (result) => {
      setCurrentResult(result);
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
  };

  return {
    generate,
    refine,
    currentResult,
    refinementCount,
    isAtRefinementLimit,
    resetResult,
  };
}
