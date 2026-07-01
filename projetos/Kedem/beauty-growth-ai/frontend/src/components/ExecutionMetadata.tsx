import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface ExecutionMetadataProps {
  executionId: string;
  modeloUtilizado: string;
  tokensConsumidos: { input: number; output: number };
  duracaoMs: number;
}

export function ExecutionMetadata({
  executionId,
  modeloUtilizado,
  tokensConsumidos,
  duracaoMs,
}: ExecutionMetadataProps) {
  const [copied, setCopied] = useState(false);

  const truncatedId = executionId.length > 8
    ? `${executionId.slice(0, 8)}...`
    : executionId;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(executionId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground mt-4 pt-3 border-t border-border">
      {/* ID da Execução */}
      <span className="inline-flex items-center gap-1">
        <span className="font-medium">ID:</span>
        <code className="font-mono">{truncatedId}</code>
        <button
          type="button"
          onClick={handleCopy}
          className="inline-flex items-center justify-center h-4 w-4 rounded hover:text-foreground transition-colors"
          title="Copiar execution_id"
          aria-label="Copiar execution_id"
        >
          {copied ? (
            <Check className="h-3 w-3 text-green-500" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </button>
      </span>

      {/* Modelo */}
      <span>
        <span className="font-medium">Modelo:</span> {modeloUtilizado}
      </span>

      {/* Tokens */}
      <span>
        <span className="font-medium">Tokens:</span> {tokensConsumidos.input} entrada / {tokensConsumidos.output} saída
      </span>

      {/* Duração */}
      <span>
        <span className="font-medium">Duração:</span> {duracaoMs}ms
      </span>
    </div>
  );
}
