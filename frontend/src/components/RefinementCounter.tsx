interface RefinementCounterProps {
  count: number;
}

const MAX_REFINEMENTS = 5;

export function RefinementCounter({ count }: RefinementCounterProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium text-muted-foreground">
        Refinamentos:
      </span>
      <div className="flex gap-1">
        {Array.from({ length: MAX_REFINEMENTS }).map((_, i) => (
          <div
            key={i}
            className={`size-2 rounded-full transition-colors duration-200 ${
              i < count ? 'bg-primary' : 'bg-muted'
            }`}
          />
        ))}
      </div>
      <span className="text-xs text-muted-foreground">
        {count}/{MAX_REFINEMENTS}
      </span>
    </div>
  );
}
