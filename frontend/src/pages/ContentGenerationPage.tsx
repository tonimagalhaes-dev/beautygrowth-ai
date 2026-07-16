import { useState } from 'react';
import { Pencil } from 'lucide-react';

import { useContentAgent } from '@/hooks/useContentAgent';
import { useDesignerAgent } from '@/hooks/useDesignerAgent';
import { BriefingForm } from '@/components/BriefingForm';
import { ResultPanel } from '@/components/ResultPanel';
import { RefinementOverlay } from '@/components/RefinementOverlay';
import { Button } from '@/components/ui/button';
import type { GenerateBriefing } from '@/types/content-agent';

export function ContentGenerationPage() {
  const { generate, refine, currentResult, refinementCount, isAtRefinementLimit } =
    useContentAgent();

  const { state: designerState, result: designerResult, triggerGeneration, isGenerating } =
    useDesignerAgent();

  const [refinementOpen, setRefinementOpen] = useState(false);

  function handleGenerate(data: GenerateBriefing) {
    generate.mutate(data);
  }

  function handleRefine(instrucoes: string) {
    if (!currentResult) return;
    refine.mutate({ executionId: currentResult.executionId, instrucoes });
  }

  // Primeira legenda como resumo do conteúdo para o overlay
  const currentContentSummary = currentResult
    ? (Object.values(currentResult.legendas)[0] ?? '')
    : '';

  return (
    <div className="h-full w-full p-4 md:p-6">
      <h1 className="text-2xl font-bold mb-6">Geração de Conteúdo</h1>

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
            <h2 className="text-lg font-semibold">
              Resultado
            </h2>

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
    </div>
  );
}
