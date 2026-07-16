import { useState, useRef, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { designerAgentService } from '@/services/designer-agent.service';
import { showErrorToast } from '@/lib/toast-utils';
import type {
  DesignerAgentState,
  DesignerAgentExecution,
  UseDesignerAgentReturn,
} from '@/types/designer-agent';

const POLLING_INTERVAL_MS = 3_000;
const MAX_POLLING_ATTEMPTS = 40; // 40 * 3s = 120s
const MAX_NETWORK_RETRIES = 3;

export function useDesignerAgent(): UseDesignerAgentReturn {
  const [state, setState] = useState<DesignerAgentState>('idle');
  const [result, setResult] = useState<DesignerAgentExecution | null>(null);
  const [error, setError] = useState<string | null>(null);

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptCountRef = useRef<number>(0);
  const networkRetryCountRef = useRef<number>(0);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    attemptCountRef.current = 0;
    networkRetryCountRef.current = 0;
  }, []);

  const startPolling = useCallback(
    (executionId: string) => {
      attemptCountRef.current = 0;
      networkRetryCountRef.current = 0;

      intervalRef.current = setInterval(async () => {
        attemptCountRef.current += 1;

        // Timeout check
        if (attemptCountRef.current > MAX_POLLING_ATTEMPTS) {
          stopPolling();
          setState('error');
          setError('Tempo limite esgotado');
          toast.error(
            'Tempo limite esgotado na geração da imagem. Tente novamente.',
          );
          return;
        }

        try {
          const execution = await designerAgentService.getExecution(executionId);
          // Reset network retry counter on successful request
          networkRetryCountRef.current = 0;

          switch (execution.status) {
            case 'generated':
              stopPolling();
              setState('generated');
              setResult(execution);
              setError(null);
              break;

            case 'guardrail_blocked':
              stopPolling();
              setState('error');
              setError('Imagem não gerada por restrições de conformidade');
              toast.error(
                'A imagem não pôde ser gerada por restrições de conformidade.',
              );
              break;

            case 'error':
              stopPolling();
              setState('error');
              setError('Falha na geração da imagem');
              toast.error('Falha na geração da imagem. Tente novamente.');
              break;

            case 'processing':
              // Continue polling
              break;
          }
        } catch (err) {
          networkRetryCountRef.current += 1;

          if (networkRetryCountRef.current >= MAX_NETWORK_RETRIES) {
            stopPolling();
            setState('error');
            setError('Erro de conectividade');
            toast.error(
              'Erro de conectividade. Verifique sua conexão e tente novamente.',
            );
          }
        }
      }, POLLING_INTERVAL_MS);
    },
    [stopPolling],
  );

  const triggerGeneration = useCallback(
    async (contentExecutionId: string) => {
      if (state === 'processing') return;

      setState('processing');
      setResult(null);
      setError(null);

      try {
        const response = await designerAgentService.fromContent({
          contentExecutionId,
        });
        startPolling(response.executionId);
      } catch (err) {
        setState('error');
        setError('Erro ao iniciar geração');
        showErrorToast(err);
      }
    },
    [state, startPolling],
  );

  const reset = useCallback(() => {
    stopPolling();
    setState('idle');
    setResult(null);
    setError(null);
  }, [stopPolling]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  const isGenerating = state === 'processing';

  return {
    state,
    result,
    triggerGeneration,
    isGenerating,
    error,
    reset,
  };
}
