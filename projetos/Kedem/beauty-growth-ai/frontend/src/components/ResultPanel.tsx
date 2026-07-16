import { Loader2 } from 'lucide-react';
import type { ContentAgentResult } from '@/types/content-agent';
import type { DesignerAgentState, DesignerAgentExecution } from '@/types/designer-agent';
import { SocialMediaTabs } from '@/components/SocialMediaTabs';
import { HashtagChips } from '@/components/HashtagChips';
import { VisualSuggestionCard } from '@/components/VisualSuggestionCard';
import { ExecutionMetadata } from '@/components/ExecutionMetadata';
import { GenerateImageButton } from '@/components/GenerateImageButton';
import { ImagePreview } from '@/components/ImagePreview';
import { ImagePreviewLoader } from '@/components/ImagePreviewLoader';

interface ResultPanelProps {
  result: ContentAgentResult | null;
  isLoading: boolean;
  designerState?: DesignerAgentState;
  designerResult?: DesignerAgentExecution | null;
  onGenerateImage?: () => void;
  isGenerating?: boolean;
}

export function ResultPanel({
  result,
  isLoading,
  designerState = 'idle',
  designerResult = null,
  onGenerateImage,
  isGenerating = false,
}: ResultPanelProps) {
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3 text-muted-foreground">
        <Loader2 className="size-8 animate-spin" />
        <p className="text-sm">Gerando conteúdo...</p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="flex items-center justify-center h-48">
        <p className="text-sm text-muted-foreground text-center">
          Preencha o briefing e clique em &ldquo;Gerar Conteúdo&rdquo; para
          visualizar o resultado.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Legendas por rede social */}
      <section>
        <h3 className="text-sm font-medium mb-2">Legendas</h3>
        <SocialMediaTabs legendas={result.legendas} />
      </section>

      {/* Hashtags */}
      <section>
        <h3 className="text-sm font-medium mb-2">Hashtags</h3>
        <HashtagChips hashtags={result.hashtags} />
      </section>

      {/* Sugestões visuais */}
      <section>
        <h3 className="text-sm font-medium mb-2">Sugestões Visuais</h3>
        <VisualSuggestionCard sugestoes={result.sugestoesVisuais} />
      </section>

      {/* Designer Agent — Geração de Imagem */}
      {onGenerateImage && (
        <section className="space-y-4">
          <h3 className="text-sm font-medium mb-2">Imagem Gerada</h3>

          <GenerateImageButton
            onClick={onGenerateImage}
            isLoading={isGenerating}
            isProcessing={designerState === 'processing'}
            hasResult={designerState === 'generated' && designerResult !== null}
          />

          {designerState === 'processing' && <ImagePreviewLoader />}

          {designerState === 'generated' && designerResult && (
            <div className="transition-opacity duration-300 animate-in fade-in">
              <ImagePreview
                images={designerResult.images}
                warnings={designerResult.warnings}
              />
            </div>
          )}

          {designerState === 'error' && (
            <p className="text-sm text-destructive">
              Ocorreu um erro na geração da imagem. Tente novamente.
            </p>
          )}
        </section>
      )}

      {/* Metadados da execução */}
      <ExecutionMetadata
        executionId={result.executionId}
        modeloUtilizado={result.modeloUtilizado}
        tokensConsumidos={result.tokensConsumidos}
        duracaoMs={result.duracaoMs}
      />
    </div>
  );
}
