import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface ColorPickerProps {
  colors: string[];
  onChange: (colors: string[]) => void;
  error?: string;
}

export function ColorPicker({ colors, onChange, error }: ColorPickerProps) {
  const handleColorChange = (index: number, newColor: string) => {
    const updated = [...colors];
    updated[index] = newColor;
    onChange(updated);
  };

  const handleAddColor = () => {
    onChange([...colors, '#000000']);
  };

  const handleRemoveColor = (index: number) => {
    if (colors.length <= 1) return;
    const updated = colors.filter((_, i) => i !== index);
    onChange(updated);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {colors.map((color, index) => (
          <div
            key={index}
            className="flex items-center gap-2 rounded-lg border border-input bg-background px-2 py-1.5"
          >
            {/* Swatch de cor com input nativo */}
            <label className="relative cursor-pointer">
              <div
                className="h-6 w-6 rounded-full border border-input"
                style={{ backgroundColor: color }}
              />
              <Input
                type="color"
                value={color}
                onChange={(e) => handleColorChange(index, e.target.value)}
                className="absolute inset-0 h-6 w-6 cursor-pointer opacity-0"
              />
            </label>

            {/* Exibição do valor hex */}
            <span className="text-xs font-mono text-muted-foreground uppercase">
              {color}
            </span>

            {/* Botão remover */}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => handleRemoveColor(index)}
              disabled={colors.length <= 1}
              className={cn(
                'text-muted-foreground hover:text-destructive',
                colors.length <= 1 && 'invisible'
              )}
            >
              <X className="size-3" />
            </Button>
          </div>
        ))}
      </div>

      {/* Botão adicionar cor */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleAddColor}
      >
        <Plus className="size-3.5" data-icon="inline-start" />
        Adicionar cor
      </Button>

      {/* Mensagem de erro */}
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
