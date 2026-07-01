import { Badge } from "@/components/ui/badge";

interface HashtagChipsProps {
  hashtags: string[];
}

export function HashtagChips({ hashtags }: HashtagChipsProps) {
  if (hashtags.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {hashtags.map((tag, index) => {
        const formattedTag = tag.startsWith("#") ? tag : `#${tag}`;
        return (
          <Badge key={`${formattedTag}-${index}`} variant="secondary">
            {formattedTag}
          </Badge>
        );
      })}
    </div>
  );
}
