import { useState, useCallback } from 'react';
import { StepIndicator } from '@/components/StepIndicator';
import { ClinicRegistrationStep } from '@/pages/onboarding/ClinicRegistrationStep';
import { BrandIdentityStep } from '@/pages/onboarding/BrandIdentityStep';
import type { CreateClinicRequest, CreateBrandRequest } from '@/types/clinic';

export function OnboardingPage() {
  const [currentStep, setCurrentStep] = useState<1 | 2>(1);
  const [clinicData, setClinicData] = useState<CreateClinicRequest>({
    nome: '',
    telefone: '',
    email: '',
    especialidades: [],
    publicoAlvo: '',
  });
  const [brandData, setBrandData] = useState<CreateBrandRequest>({
    tomDeVoz: '',
    paletaDeCores: [],
    publicoAlvo: '',
    diferenciais: [],
    valores: [],
  });

  const onStepOneComplete = useCallback((data: CreateClinicRequest) => {
    setClinicData(data);
    setCurrentStep(2);
  }, []);

  const goBack = useCallback(() => {
    setCurrentStep(1);
  }, []);

  const handleBrandDataChange = useCallback((data: CreateBrandRequest) => {
    setBrandData(data);
  }, []);

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-6">
      <StepIndicator currentStep={currentStep} totalSteps={2} />

      {currentStep === 1 && (
        <ClinicRegistrationStep
          initialData={clinicData}
          onSuccess={onStepOneComplete}
        />
      )}

      {currentStep === 2 && (
        <BrandIdentityStep
          initialData={brandData}
          onBack={goBack}
          onDataChange={handleBrandDataChange}
        />
      )}
    </div>
  );
}
