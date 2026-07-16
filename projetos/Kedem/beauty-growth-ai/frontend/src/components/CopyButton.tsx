import { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

interface CopyButtonProps {
  text: string;
  ariaLabel: string;
}

export function CopyButton({ text, ariaLabel }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success('Descrição copiada para a área de transferência.');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(
        'Não foi possível copiar. Selecione o texto e copie manualmente.',
      );
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={ariaLabel}
      onClick={handleCopy}
    >
      {copied ? (
        <Check className="size-3.5 text-green-600" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </Button>
  );
}
