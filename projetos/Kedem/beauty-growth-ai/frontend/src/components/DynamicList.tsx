import { Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface DynamicListProps {
  items: string[];
  onChange: (items: string[]) => void;
  label: string;
  placeholder?: string;
  maxItems?: number;
  maxChars?: number;
  error?: string;
}

export function DynamicList({
  items,
  onChange,
  label,
  placeholder = 'Digite um item...',
  maxItems = 5,
  maxChars = 200,
  error,
}: DynamicListProps) {
  const isAtMax = items.length >= maxItems;

  function handleAdd() {
    if (isAtMax) return;
    onChange([...items, '']);
  }

  function handleRemove(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function handleChange(index: number, value: string) {
    if (value.length > maxChars) return;
    const updated = [...items];
    updated[index] = value;
    onChange(updated);
  }

  return (
    <div className="space-y-3">
      <Label>{label}</Label>

      <div className="space-y-2">
        {items.map((item, index) => (
          <div key={index} className="flex items-center gap-2">
            <div className="relative flex-1">
              <Input
                value={item}
                onChange={(e) => handleChange(index, e.target.value)}
                placeholder={placeholder}
                maxLength={maxChars}
              />
              <span
                className={cn(
                  'absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground',
                  item.length >= maxChars && 'text-destructive'
                )}
              >
                {item.length}/{maxChars}
              </span>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => handleRemove(index)}
              aria-label={`Remover item ${index + 1}`}
            >
              <X className="size-4" />
            </Button>
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleAdd}
        disabled={isAtMax}
        className="gap-1.5"
      >
        <Plus className="size-3.5" />
        Adicionar
      </Button>

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}
