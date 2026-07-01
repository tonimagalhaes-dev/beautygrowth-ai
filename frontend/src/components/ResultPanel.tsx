import { Loader2 } from 'lucide-react';
import type { ContentAgentResult } from '@/types/content-agent';
import { SocialMediaTabs } from '@/components/SocialMediaTabs';
import { HashtagChips } from '@/components/HashtagChips';
import { VisualSuggestionCard } from '@/components/VisualSuggestionCard';
import { ExecutionMetadata } from '@/components/ExecutionMetadata';

interface ResultPanelProps {
  result: ContentAgentResult | null;
  isLoading: boolean;
}

export function ResultPanel({ result, isLoading }: ResultPanelProps) {
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
