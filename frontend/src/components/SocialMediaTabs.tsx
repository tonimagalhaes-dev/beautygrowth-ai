import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

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
          <p className="whitespace-pre-wrap text-sm text-foreground leading-relaxed">
            {legendas[rede]}
          </p>
        </TabsContent>
      ))}
    </Tabs>
  );
}
