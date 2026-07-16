import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { CopyButton } from '@/components/CopyButton';

interface SugestaoVisualItem {
  formato: string;
  descricao: string;
}

interface VisualSuggestionCardProps {
  sugestoes: Record<string, SugestaoVisualItem>;
}

function capitalizeRedeSocial(rede: string): string {
  return rede.charAt(0).toUpperCase() + rede.slice(1);
}

export function VisualSuggestionCard({ sugestoes }: VisualSuggestionCardProps) {
  const redes = Object.entries(sugestoes);

  if (redes.length === 0) {
    return null;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {redes.map(([rede, sugestao]) => (
        <Card key={rede} className="hover:shadow-md overflow-visible">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-medium">{capitalizeRedeSocial(rede)}</CardTitle>
              <CopyButton
                text={sugestao.descricao}
                ariaLabel={`Copiar descrição visual para ${rede}`}
              />
            </div>
            <CardDescription className="text-xs">Sugestão visual</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-2">
              <span className="text-lg font-semibold text-primary">
                {sugestao.formato}
              </span>
              <span className="ml-2 text-xs text-muted-foreground">
                formato
              </span>
            </div>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap break-words">{sugestao.descricao}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
