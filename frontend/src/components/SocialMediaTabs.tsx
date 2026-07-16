import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CopyButton } from '@/components/CopyButton';

interface SocialMediaTabsProps {
  legendas: Record<string, string>;
}

const REDE_LABELS: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  tiktok: 'TikTok',
};

function getRedeLabel(rede: string): string {
  return REDE_LABELS[rede] || rede.charAt(0).toUpperCase() + rede.slice(1);
}

export function SocialMediaTabs({ legendas }: SocialMediaTabsProps) {
  const redes = Object.keys(legendas);

  if (redes.length === 0) {
    return null;
  }

  return (
    <Tabs defaultValue={redes[0]}>
      <TabsList>
        {redes.map((rede) => (
          <TabsTrigger key={rede} value={rede}>
            {getRedeLabel(rede)}
          </TabsTrigger>
        ))}
      </TabsList>

      {redes.map((rede) => (
        <TabsContent key={rede} value={rede}>
          <div className="relative group">
            <div className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <CopyButton
                text={legendas[rede]}
                ariaLabel={`Copiar legenda para ${getRedeLabel(rede)}`}
              />
            </div>
            <p className="whitespace-pre-wrap text-sm text-foreground leading-relaxed pr-8">
              {legendas[rede]}
            </p>
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}
