import { Loader2 } from 'lucide-react';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { CacheEntryCard } from '@/components/CacheEntryCard';
import { usePromptCache } from '@/hooks/usePromptCache';
import type { CacheEntryPreview } from '@/types/prompt-cache';

interface HistoryPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectEntry: (entry: CacheEntryPreview) => void;
  onRefineEntry: (entry: CacheEntryPreview) => void;
}

export function HistoryPanel({
  open,
  onOpenChange,
  onSelectEntry,
  onRefineEntry,
}: HistoryPanelProps) {
  const { entries } = usePromptCache();

  const allEntries = entries.data?.pages.flatMap((page) => page.data) ?? [];
  const hasEntries = allEntries.length > 0;
  const isLoadingInitial = entries.isLoading;
  const isLoadingMore = entries.isFetchingNextPage;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex flex-col">
        <SheetHeader>
          <SheetTitle>Histórico de Gerações</SheetTitle>
          <SheetDescription>
            Navegue por conteúdos gerados anteriormente.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-4">
          {isLoadingInitial && (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {!isLoadingInitial && !hasEntries && (
            <div className="flex items-center justify-center h-32">
              <p className="text-sm text-muted-foreground text-center">
                Nenhuma geração encontrada. Gere conteúdo para visualizar o histórico.
              </p>
            </div>
          )}

          {hasEntries && (
            <>
              {allEntries.map((entry) => (
                <CacheEntryCard
                  key={entry.id}
                  entry={entry}
                  onSelect={() => onSelectEntry(entry)}
                  onRefine={() => onRefineEntry(entry)}
                />
              ))}

              {entries.hasNextPage && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => entries.fetchNextPage()}
                  disabled={isLoadingMore}
                >
                  {isLoadingMore && (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  )}
                  {isLoadingMore ? 'Carregando...' : 'Carregar mais'}
                </Button>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
