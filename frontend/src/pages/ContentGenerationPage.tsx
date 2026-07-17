import { useState } from 'react';
import { Clock, Pencil } from 'lucide-react';

import { useContentAgent } from '@/hooks/useContentAgent';
import { useDesignerAgent } from '@/hooks/useDesignerAgent';
import { usePromptCache } from '@/hooks/usePromptCache';
import { BriefingForm } from '@/components/BriefingForm';
import { ResultPanel } from '@/components/ResultPanel';
import { RefinementOverlay } from '@/components/RefinementOverlay';
import { HistoryPanel } from '@/components/HistoryPanel';
import { SimilarMatchConfirmation } from '@/components/SimilarMatchConfirmation';
import { CacheSourceBadge } from '@/components/CacheSourceBadge';
import { Button } from '@/components/ui/button';
import type { GenerateBriefing } from '@/types/content-agent';
import type { CacheEntryPreview } from '@/types/prompt-cache';

export function ContentGenerationPage() {
  const {
    generate,
    refine,
    currentResult,
    refinementCount,
    isAtRefinementLimit,
    similarMatch,
    confirmSimilar,
    dismissSimilar,
    loadCachedResult,
  } = useContentAgent();

  const { state: designerState, result: designerResult, triggerGeneration, isGenerating } =
    useDesignerAgent();

  const { getEntry } = usePromptCache();

  const [refinementOpen, setRefinementOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  function handleGenerate(data: GenerateBriefing) {
    generate.mutate(data);
  }

  function handleRefine(instrucoes: string) {
    if (!currentResult) return;
    refine.mutate({ executionId: currentResult.executionId, instrucoes });
  }

  function handleSelectEntry(entry: CacheEntryPreview) {
    getEntry.mutate(entry.id, {
      onSuccess: (detail) => {
        const result = {
          ...detail.responsePayload,
          source: 'cache' as const,
        };
        loadCachedResult(result);
        setHistoryOpen(false);
      },
    });
  }

  function handleRefineEntry(entry: CacheEntryPreview) {
    getEntry.mutate(entry.id, {
      onSuccess: (detail) => {
        const result = {
          ...detail.responsePayload,
          source: 'cache' as const,
        };
        loadCachedResult(result);
        setHistoryOpen(false);
        setRefinementOpen(true);
      },
    });
  }

  // Primeira legenda como resumo do conteúdo para o overlay
  const currentContentSummary = currentResult
    ? (Object.values(currentResult.legendas)[0] ?? '')
    : '';

  return (
    <div className="h-full w-full p-4 md:p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Geração de Conteúdo</h1>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setHistoryOpen(true)}
        >
          <Clock className="mr-2 size-4" />
          Histórico
        </Button>
      </div>

      <div className="flex flex-col md:flex-row gap-6 h-[calc(100%-4rem)]">
        {/* Painel Esquerdo — Briefing (40%) */}
        <section className="w-full md:w-2/5 rounded-lg border border-border bg-card p-4 transition-shadow duration-200 hover:shadow-md overflow-y-auto">
          <h2 className="text-lg font-semibold mb-4">Briefing</h2>
          <BriefingForm
            onSubmit={handleGenerate}
            isLoading={generate.isPending}
          />
        </section>

        {/* Painel Direito — Resultado (60%) */}
        <section className="w-full md:w-3/5 rounded-lg border border-border bg-card p-4 transition-shadow duration-200 hover:shadow-md overflow-y-auto">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">Resultado</h2>
              {currentResult?.source && (
                <CacheSourceBadge source={currentResult.source} />
              )}
            </div>

            {currentResult && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRefinementOpen(true)}
                disabled={isAtRefinementLimit}
              >
                <Pencil className="mr-2 size-4" />
                {isAtRefinementLimit ? 'Limite atingido' : 'Refinar'}
              </Button>
            )}
          </div>

          <ResultPanel
            result={currentResult}
            isLoading={generate.isPending}
            designerState={designerState}
            designerResult={designerResult}
            onGenerateImage={() => {
              if (currentResult?.executionId) {
                triggerGeneration(currentResult.executionId);
              }
            }}
            isGenerating={isGenerating}
          />
        </section>
      </div>

      {/* Overlay de Refinamento */}
      <RefinementOverlay
        open={refinementOpen}
        onOpenChange={setRefinementOpen}
        currentContent={currentContentSummary}
        onRefine={handleRefine}
        isLoading={refine.isPending}
        refinementCount={refinementCount}
        isAtRefinementLimit={isAtRefinementLimit}
      />

      {/* History Panel */}
      <HistoryPanel
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        onSelectEntry={handleSelectEntry}
        onRefineEntry={handleRefineEntry}
      />

      {/* Similar Match Confirmation Dialog */}
      <SimilarMatchConfirmation
        open={!!similarMatch}
        entry={similarMatch}
        onConfirm={confirmSimilar}
        onDecline={dismissSimilar}
      />
    </div>
  );
}
