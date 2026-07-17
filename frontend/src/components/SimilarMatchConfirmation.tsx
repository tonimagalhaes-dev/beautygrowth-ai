import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ContentAgentResult } from '@/types/content-agent';

interface SimilarMatchConfirmationProps {
  open: boolean;
  entry: ContentAgentResult | null;
  onConfirm: () => void;
  onDecline: () => void;
}

export function SimilarMatchConfirmation({
  open,
  entry,
  onConfirm,
  onDecline,
}: SimilarMatchConfirmationProps) {
  if (!entry) return null;

  const firstLegenda = entry.legendas
    ? Object.values(entry.legendas)[0] ?? ''
    : '';
  const preview =
    firstLegenda.length > 150
      ? `${firstLegenda.slice(0, 150)}…`
      : firstLegenda;

  return (
    <Dialog open={open}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resultado semelhante encontrado</DialogTitle>
          <DialogDescription>
            Encontramos um conteúdo gerado anteriormente que é semelhante ao seu
            pedido. Deseja reutilizá-lo?
          </DialogDescription>
        </DialogHeader>

        {preview && (
          <div className="rounded-md border border-border bg-muted/50 p-3">
            <p className="text-xs text-muted-foreground mb-1">Prévia do conteúdo:</p>
            <p className="text-sm leading-relaxed">{preview}</p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onDecline}>
            Gerar novo conteúdo
          </Button>
          <Button onClick={onConfirm}>
            Usar resultado anterior
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
