import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { CacheEntryPreview } from '@/types/prompt-cache';

interface CacheEntryCardProps {
  entry: CacheEntryPreview;
  onSelect: () => void;
  onRefine: () => void;
}

function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return 'agora mesmo';
  if (diffMinutes < 60) return `${diffMinutes}min atrás`;
  if (diffHours < 24) return `${diffHours}h atrás`;
  if (diffDays < 7) return `${diffDays}d atrás`;

  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
  });
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

export function CacheEntryCard({ entry, onSelect, onRefine }: CacheEntryCardProps) {
  return (
    <div className="rounded-lg border border-border p-3 space-y-2 hover:bg-muted/50 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium leading-tight">
          {truncate(entry.tema, 80)}
        </p>
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatRelativeTime(entry.createdAt)}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        {entry.redesSociais.map((rede) => (
          <Badge key={rede} variant="secondary" className="text-[10px] px-1.5 py-0">
            {rede}
          </Badge>
        ))}
      </div>

      {entry.contentPreview && (
        <p className="text-xs text-muted-foreground leading-relaxed">
          {truncate(entry.contentPreview, 120)}
        </p>
      )}

      <div className="flex gap-2 pt-1">
        <Button variant="outline" size="sm" className="text-xs h-7" onClick={onSelect}>
          Usar
        </Button>
        <Button variant="ghost" size="sm" className="text-xs h-7" onClick={onRefine}>
          Refinar
        </Button>
      </div>
    </div>
  );
}
