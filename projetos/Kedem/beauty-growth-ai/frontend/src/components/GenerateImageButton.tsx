import { Button } from '@/components/ui/button';
import { ImagePlus, Loader2 } from 'lucide-react';

interface GenerateImageButtonProps {
  onClick: () => void;
  isLoading: boolean;
  isProcessing: boolean;
  hasResult: boolean;
  disabled?: boolean;
}

export function GenerateImageButton({
  onClick,
  isLoading,
  isProcessing,
  hasResult,
  disabled,
}: GenerateImageButtonProps) {
  const isBusy = isLoading || isProcessing;

  const buttonText = isBusy
    ? 'Gerando...'
    : hasResult
      ? 'Gerar Nova Imagem'
      : 'Gerar Imagem';

  return (
    <Button
      onClick={onClick}
      disabled={isBusy || disabled}
      variant="default"
      size="lg"
    >
      {isBusy ? (
        <Loader2 className="size-4 animate-spin" data-icon="inline-start" />
      ) : (
        <ImagePlus className="size-4" data-icon="inline-start" />
      )}
      {buttonText}
    </Button>
  );
}
