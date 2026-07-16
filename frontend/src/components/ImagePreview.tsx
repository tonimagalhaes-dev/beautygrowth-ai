import { useState } from 'react';
import { Download, ImageOff } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { RedeSocial } from '@/types/content-agent';
import type { ImageResult } from '@/types/designer-agent';

interface ImagePreviewProps {
  images: Record<RedeSocial, ImageResult>;
  warnings?: string[];
}

function capitalizeRedeSocial(rede: string): string {
  return rede.charAt(0).toUpperCase() + rede.slice(1);
}

async function handleDownload(url: string, redeSocial: string) {
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = `imagem-${redeSocial}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(blobUrl);
  } catch {
    // Fallback: open in new tab if fetch fails (e.g. CORS)
    window.open(url, '_blank');
  }
}

export function ImagePreview({ images, warnings }: ImagePreviewProps) {
  const [imageErrors, setImageErrors] = useState<Record<string, boolean>>({});

  const entries = Object.entries(images) as [RedeSocial, ImageResult][];

  if (entries.length === 0) {
    return null;
  }

  const gridCols =
    entries.length === 1
      ? 'grid-cols-1'
      : entries.length === 2
        ? 'grid-cols-1 sm:grid-cols-2'
        : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3';

  return (
    <div className="space-y-4">
      <div className={`grid gap-4 ${gridCols}`}>
        {entries.map(([rede, image]) => (
          <Card key={rede} className="hover:shadow-md">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                {capitalizeRedeSocial(rede)}
                <span className="ml-2 text-xs text-muted-foreground font-normal">
                  {image.aspectoRatio}
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Dialog>
                <DialogTrigger
                  className="block w-full cursor-pointer rounded-md overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Ver imagem de ${capitalizeRedeSocial(rede)} em tamanho completo`}
                >
                  {imageErrors[rede] ? (
                    <div className="flex h-40 w-full items-center justify-center rounded-md bg-muted">
                      <ImageOff className="size-8 text-muted-foreground" />
                    </div>
                  ) : (
                    <img
                      src={image.urlThumbnail}
                      alt={`Preview ${capitalizeRedeSocial(rede)} - ${image.aspectoRatio}`}
                      className="h-40 w-full rounded-md object-cover"
                      onError={() =>
                        setImageErrors((prev) => ({ ...prev, [rede]: true }))
                      }
                    />
                  )}
                </DialogTrigger>
                <DialogContent className="sm:max-w-lg">
                  <DialogTitle>
                    {capitalizeRedeSocial(rede)} — {image.aspectoRatio}
                  </DialogTitle>
                  <img
                    src={image.url}
                    alt={`Imagem completa ${capitalizeRedeSocial(rede)}`}
                    className="w-full rounded-md object-contain"
                  />
                  <div className="flex justify-end pt-2">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => handleDownload(image.url, rede)}
                    >
                      <Download data-icon="inline-start" />
                      Download
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </CardContent>
          </Card>
        ))}
      </div>

      {warnings && warnings.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {warnings.map((warning, index) => (
            <Badge key={index} variant="destructive">
              {warning}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
