import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { RefinementCounter } from '@/components/RefinementCounter';

interface RefinementOverlayProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentContent: string;
  onRefine: (instrucoes: string) => void;
  isLoading: boolean;
  refinementCount: number;
  isAtRefinementLimit: boolean;
}

export function RefinementOverlay({
  open,
  onOpenChange,
  currentContent,
  onRefine,
  isLoading,
  refinementCount,
  isAtRefinementLimit,
}: RefinementOverlayProps) {
  const [instrucoes, setInstrucoes] = useState('');

  const contentSummary =
    currentContent.length > 100
      ? `${currentContent.slice(0, 100)}…`
      : currentContent;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!instrucoes.trim() || isLoading || isAtRefinementLimit) return;
    onRefine(instrucoes.trim());
    setInstrucoes('');
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col">
        <SheetHeader>
          <SheetTitle>Refinamento de Conteúdo</SheetTitle>
          <SheetDescription>
            Ajuste o conteúdo gerado fornecendo instruções adicionais.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4">
          {/* Conteúdo atual resumido */}
          <div className="space-y-2">
            <Label className="text-sm font-medium text-muted-foreground">
              Conteúdo atual
            </Label>
            <p className="rounded-md border border-border bg-muted/50 p-3 text-sm leading-relaxed">
              {contentSummary || 'Nenhum conteúdo gerado.'}
            </p>
          </div>

          {/* Contador de refinamentos */}
          <RefinementCounter count={refinementCount} />

          {/* Formulário de refinamento */}
          <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-4">
            <div className="space-y-2">
              <Label htmlFor="instrucoes-refinamento">
                Instruções de ajuste
              </Label>
              <Textarea
                id="instrucoes-refinamento"
                placeholder="Descreva os ajustes desejados no conteúdo..."
                value={instrucoes}
                onChange={(e) => setInstrucoes(e.target.value)}
                disabled={isLoading || isAtRefinementLimit}
                required
                className="min-h-32 resize-none"
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={
                !instrucoes.trim() || isLoading || isAtRefinementLimit
              }
            >
              {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
              {isAtRefinementLimit
                ? 'Limite de refinamentos atingido'
                : isLoading
                  ? 'Refinando...'
                  : 'Refinar'}
            </Button>

            {isAtRefinementLimit && (
              <p className="text-center text-xs text-muted-foreground">
                Você atingiu o limite máximo de 5 refinamentos para esta
                execução.
              </p>
            )}
          </form>
        </div>
      </SheetContent>
    </Sheet>
  );
}
