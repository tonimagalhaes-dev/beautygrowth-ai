import { cn } from '@/lib/utils';

interface StepIndicatorProps {
  currentStep: 1 | 2;
  totalSteps?: number;
}

const stepLabels = ['Dados da Clínica', 'Identidade da Marca'];

export function StepIndicator({ currentStep, totalSteps = 2 }: StepIndicatorProps) {
  return (
    <div className="flex items-center justify-center w-full max-w-xs mx-auto">
      {Array.from({ length: totalSteps }, (_, i) => {
        const step = i + 1;
        const isActive = step <= currentStep;

        return (
          <div key={step} className="flex items-center flex-1 last:flex-none">
            {/* Círculo do passo + label */}
            <div className="flex flex-col items-center">
              <div
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'border-2 border-muted-foreground text-muted-foreground'
                )}
              >
                {step}
              </div>
              <span
                className={cn(
                  'mt-2 text-xs font-medium whitespace-nowrap',
                  isActive ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {stepLabels[i]}
              </span>
            </div>

            {/* Conector entre passos */}
            {step < totalSteps && (
              <div
                className={cn(
                  'h-0.5 flex-1 mx-3 transition-colors',
                  currentStep > 1 ? 'bg-primary' : 'bg-muted'
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
