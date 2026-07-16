import { Card, CardContent, CardHeader } from '@/components/ui/card';

/**
 * Skeleton loader exibido durante o polling de geração de imagem.
 * Mantém layout consistente com ImagePreview para evitar layout shift.
 */
export function ImagePreviewLoader() {
  return (
    <div className="space-y-4">
      <p className="text-center text-sm text-muted-foreground animate-pulse">
        Gerando imagem...
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1].map((i) => (
          <Card key={i} className="animate-pulse">
            <CardHeader className="pb-3">
              <div className="h-4 w-20 rounded bg-muted" />
              <div className="h-3 w-14 rounded bg-muted" />
            </CardHeader>
            <CardContent>
              <div className="aspect-square w-full rounded bg-muted" />
              <div className="mt-3 flex items-center justify-between">
                <div className="h-3 w-24 rounded bg-muted" />
                <div className="h-8 w-20 rounded bg-muted" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
