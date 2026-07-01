import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ColorPicker } from '@/components/ColorPicker';
import { FileUpload } from '@/components/FileUpload';
import { DynamicList } from '@/components/DynamicList';
import { useClinic } from '@/hooks/useClinic';
import type { CreateBrandRequest } from '@/types/clinic';

interface BrandIdentityStepProps {
  initialData: CreateBrandRequest;
  onBack: () => void;
  onDataChange: (data: CreateBrandRequest) => void;
}

interface FormErrors {
  tomDeVoz?: string;
  paletaDeCores?: string;
  publicoAlvo?: string;
  diferenciais?: string;
  valores?: string;
}

export function BrandIdentityStep({
  initialData,
  onBack,
  onDataChange,
}: BrandIdentityStepProps) {
  const navigate = useNavigate();
  const [formData, setFormData] = useState<CreateBrandRequest>(initialData);
  const [errors, setErrors] = useState<FormErrors>({});
  const { createBrand } = useClinic({ statusEnabled: false });

  function updateField<K extends keyof CreateBrandRequest>(
    field: K,
    value: CreateBrandRequest[K]
  ) {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field as keyof FormErrors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  }

  function validate(): FormErrors {
    const newErrors: FormErrors = {};

    if (!formData.tomDeVoz.trim()) {
      newErrors.tomDeVoz = 'Tom de voz é obrigatório';
    } else if (formData.tomDeVoz.length > 500) {
      newErrors.tomDeVoz = 'Tom de voz deve ter no máximo 500 caracteres';
    }

    if (formData.paletaDeCores.length === 0) {
      newErrors.paletaDeCores = 'Selecione ao menos 1 cor';
    }

    if (!formData.publicoAlvo.trim()) {
      newErrors.publicoAlvo = 'Público-alvo é obrigatório';
    } else if (formData.publicoAlvo.length > 300) {
      newErrors.publicoAlvo = 'Público-alvo deve ter no máximo 300 caracteres';
    }

    const filledDiferenciais = formData.diferenciais.filter((d) => d.trim());
    if (filledDiferenciais.length === 0) {
      newErrors.diferenciais = 'Adicione ao menos 1 diferencial';
    }

    const filledValores = formData.valores.filter((v) => v.trim());
    if (filledValores.length === 0) {
      newErrors.valores = 'Adicione ao menos 1 valor';
    }

    return newErrors;
  }

  function handleBack() {
    onDataChange(formData);
    onBack();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    // Remove itens vazios antes de enviar
    const cleanedData: CreateBrandRequest = {
      ...formData,
      diferenciais: formData.diferenciais.filter((d) => d.trim()),
      valores: formData.valores.filter((v) => v.trim()),
    };

    createBrand.mutate(cleanedData, {
      onSuccess: () => {
        toast.success('Identidade da marca configurada com sucesso!');
        navigate('/content');
      },
      onError: (error) => {
        const message =
          (error as { response?: { data?: { message?: string } } })?.response
            ?.data?.message ||
          'Erro ao salvar identidade da marca. Tente novamente.';
        toast.error(message);
      },
    });
  }

  const isLoading = createBrand.isPending;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Identidade da Marca</h2>
        <p className="text-sm text-muted-foreground">
          Defina a identidade visual e o tom de voz da sua clínica para que o
          conteúdo gerado reflita a personalidade da sua marca.
        </p>
      </div>

      {/* Tom de Voz */}
      <div className="space-y-2">
        <Label htmlFor="tomDeVoz">Tom de Voz</Label>
        <div className="relative">
          <Textarea
            id="tomDeVoz"
            placeholder="Descreva o tom de voz da sua marca (ex: profissional e acolhedor, sofisticado e acessível...)"
            value={formData.tomDeVoz}
            onChange={(e) => updateField('tomDeVoz', e.target.value)}
            disabled={isLoading}
            maxLength={500}
            rows={3}
            aria-invalid={!!errors.tomDeVoz}
          />
          <span className="absolute bottom-2 right-2 text-xs text-muted-foreground">
            {formData.tomDeVoz.length}/500
          </span>
        </div>
        {errors.tomDeVoz && (
          <p className="text-sm text-destructive">{errors.tomDeVoz}</p>
        )}
      </div>

      {/* Paleta de Cores */}
      <div className="space-y-2">
        <Label>Paleta de Cores</Label>
        <ColorPicker
          colors={formData.paletaDeCores}
          onChange={(colors) => updateField('paletaDeCores', colors)}
          error={errors.paletaDeCores}
        />
      </div>

      {/* Logotipo */}
      <div className="space-y-2">
        <Label>Logotipo (opcional)</Label>
        <FileUpload
          file={formData.logotipo ?? null}
          onChange={(file) => updateField('logotipo', file ?? undefined)}
        />
      </div>

      {/* Público-Alvo */}
      <div className="space-y-2">
        <Label htmlFor="publicoAlvo">Público-Alvo</Label>
        <div className="relative">
          <Textarea
            id="publicoAlvo"
            placeholder="Descreva o público-alvo da sua marca (ex: mulheres de 25-50 anos que buscam procedimentos estéticos...)"
            value={formData.publicoAlvo}
            onChange={(e) => updateField('publicoAlvo', e.target.value)}
            disabled={isLoading}
            maxLength={300}
            rows={3}
            aria-invalid={!!errors.publicoAlvo}
          />
          <span className="absolute bottom-2 right-2 text-xs text-muted-foreground">
            {formData.publicoAlvo.length}/300
          </span>
        </div>
        {errors.publicoAlvo && (
          <p className="text-sm text-destructive">{errors.publicoAlvo}</p>
        )}
      </div>

      {/* Diferenciais */}
      <DynamicList
        items={formData.diferenciais}
        onChange={(items) => updateField('diferenciais', items)}
        label="Diferenciais"
        placeholder="Ex: Equipe com mais de 10 anos de experiência"
        maxItems={5}
        maxChars={200}
        error={errors.diferenciais}
      />

      {/* Valores */}
      <DynamicList
        items={formData.valores}
        onChange={(items) => updateField('valores', items)}
        label="Valores da Clínica"
        placeholder="Ex: Excelência no atendimento"
        maxItems={5}
        maxChars={200}
        error={errors.valores}
      />

      {/* Ações */}
      <div className="flex gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={handleBack}
          disabled={isLoading}
        >
          Voltar
        </Button>
        <Button type="submit" className="flex-1" disabled={isLoading}>
          {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isLoading ? 'Salvando...' : 'Concluir'}
        </Button>
      </div>
    </form>
  );
}
