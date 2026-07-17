import { Badge } from '@/components/ui/badge';

interface CacheSourceBadgeProps {
  source: 'cache' | 'generated';
}

export function CacheSourceBadge({ source }: CacheSourceBadgeProps) {
  if (source === 'cache') {
    return (
      <Badge className="bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-300 dark:border-green-800">
        Cache
      </Badge>
    );
  }

  return (
    <Badge className="bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-800">
      Gerado
    </Badge>
  );
}
