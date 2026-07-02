import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { useClinic } from '@/hooks/useClinic';
import type { CreateClinicRequest } from '@/types/clinic';

const ESPECIALIDADES_OPTIONS = [
  'Harmonização Facial',
  'Botox',
  'Preenchimento Labial',
  'Bioestimuladores',
  'Fios de PDO',
  'Limpeza de Pele',
  'Peeling',
  'Microagulhamento',
  'Laser',
  'Depilação a Laser',
  'Criolipólise',
  'Lipocavitação',
  'Radiofrequência',
  'Drenagem Linfática',
  'Massagem Modeladora',
  'Tratamento de Acne',
  'Tratamento de Melasma',
  'Tratamento Capilar',
];

interface ClinicRegistrationStepProps {
  initialData: CreateClinicRequest;
  onSuccess: (data: CreateClinicRequest) => void;
}

interface FormErrors {
  nome?: string;
  telefone?: string;
  email?: string;
  especialidades?: string;
  publicoAlvo?: string;
}

function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 11);

  if (digits.length <= 2) return digits;
  if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 11;
}

export function ClinicRegistrationStep({
  initialData,
  onSuccess,
}: ClinicRegistrationStepProps) {
  const [formData, setFormData] = useState<CreateClinicRequest>(initialData);
  const [errors, setErrors] = useState<FormErrors>({});
  const { createClinic } = useClinic({ statusEnabled: false });

  function handleChange(field: keyof CreateClinicRequest, value: string) {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (errors[field as keyof FormErrors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  }

  function handlePhoneChange(value: string) {
    const formatted = formatPhone(value);
    setFormData((prev) => ({ ...prev, telefone: formatted }));
    if (errors.telefone) {
      setErrors((prev) => ({ ...prev, telefone: undefined }));
    }
  }

  function handleEspecialidadeToggle(especialidade: string) {
    setFormData((prev) => {
      const current = prev.especialidades;
      const updated = current.includes(especialidade)
        ? current.filter((e) => e !== especialidade)
        : [...current, especialidade];
      return { ...prev, especialidades: updated };
    });
    if (errors.especialidades) {
      setErrors((prev) => ({ ...prev, especialidades: undefined }));
    }
  }

  function validate(): FormErrors {
    const newErrors: FormErrors = {};

    if (!formData.nome.trim()) {
      newErrors.nome = 'Nome da clínica é obrigatório';
    }

    if (!formData.telefone.trim()) {
      newErrors.telefone = 'Telefone é obrigatório';
    } else if (!isValidPhone(formData.telefone)) {
      newErrors.telefone = 'Telefone deve ter DDD + 9 dígitos (ex: (11) 99999-9999)';
    }

    if (!formData.email.trim()) {
      newErrors.email = 'E-mail é obrigatório';
    } else if (!isValidEmail(formData.email)) {
      newErrors.email = 'Formato de e-mail inválido';
    }

    if (formData.especialidades.length === 0) {
      newErrors.especialidades = 'Selecione ao menos uma especialidade';
    }

    if (!formData.publicoAlvo.trim()) {
      newErrors.publicoAlvo = 'Público-alvo é obrigatório';
    }

    return newErrors;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const validationErrors = validate();
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }

    createClinic.mutate(formData, {
      onSuccess: () => {
        onSuccess(formData);
      },
      onError: (error) => {
        const message =
          (error as { response?: { data?: { message?: string } } })?.response
            ?.data?.message || 'Erro ao cadastrar clínica. Tente novamente.';
        toast.error(message);
      },
    });
  }

  const isLoading = createClinic.isPending;

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Dados da Clínica</h2>
        <p className="text-sm text-muted-foreground">
          Preencha as informações básicas da sua clínica para personalizar o conteúdo gerado.
        </p>
      </div>

      {/* Nome */}
      <div className="space-y-2">
        <Label htmlFor="nome">Nome da Clínica</Label>
        <Input
          id="nome"
          placeholder="Ex: Clínica Bella Vita"
          value={formData.nome}
          onChange={(e) => handleChange('nome', e.target.value)}
          disabled={isLoading}
          aria-invalid={!!errors.nome}
        />
        {errors.nome && (
          <p className="text-sm text-destructive">{errors.nome}</p>
        )}
      </div>

      {/* Telefone */}
      <div className="space-y-2">
        <Label htmlFor="telefone">Telefone</Label>
        <Input
          id="telefone"
          placeholder="(11) 99999-9999"
          value={formData.telefone}
          onChange={(e) => handlePhoneChange(e.target.value)}
          disabled={isLoading}
          aria-invalid={!!errors.telefone}
        />
        {errors.telefone && (
          <p className="text-sm text-destructive">{errors.telefone}</p>
        )}
      </div>

      {/* Email */}
      <div className="space-y-2">
        <Label htmlFor="email">E-mail</Label>
        <Input
          id="email"
          type="email"
          placeholder="contato@clinica.com.br"
          value={formData.email}
          onChange={(e) => handleChange('email', e.target.value)}
          disabled={isLoading}
          aria-invalid={!!errors.email}
        />
        {errors.email && (
          <p className="text-sm text-destructive">{errors.email}</p>
        )}
      </div>

      {/* Especialidades */}
      <div className="space-y-3">
        <Label>Especialidades</Label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ESPECIALIDADES_OPTIONS.map((especialidade) => (
            <label
              key={especialidade}
              className="flex items-center gap-2 cursor-pointer"
            >
              <Checkbox
                checked={formData.especialidades.includes(especialidade)}
                onCheckedChange={() => handleEspecialidadeToggle(especialidade)}
                disabled={isLoading}
              />
              <span className="text-sm">{especialidade}</span>
            </label>
          ))}
        </div>
        {errors.especialidades && (
          <p className="text-sm text-destructive">{errors.especialidades}</p>
        )}
      </div>

      {/* Público-Alvo */}
      <div className="space-y-2">
        <Label htmlFor="publicoAlvo">Público-Alvo</Label>
        <Textarea
          id="publicoAlvo"
          placeholder="Descreva o público-alvo da sua clínica (ex: Mulheres de 25-50 anos, classes A e B...)"
          value={formData.publicoAlvo}
          onChange={(e) => handleChange('publicoAlvo', e.target.value)}
          disabled={isLoading}
          aria-invalid={!!errors.publicoAlvo}
        />
        {errors.publicoAlvo && (
          <p className="text-sm text-destructive">{errors.publicoAlvo}</p>
        )}
      </div>

      {/* Enviar */}
      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {isLoading ? 'Cadastrando...' : 'Continuar'}
      </Button>
    </form>
  );
}
