import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { RedeSocial, GenerateBriefing } from '@/types/content-agent';

interface FormErrors {
  tema?: string;
  redesSociais?: string;
}

interface BriefingFormProps {
  onSubmit: (data: GenerateBriefing) => void;
  isLoading?: boolean;
}

const REDES_SOCIAIS: { id: RedeSocial; label: string }[] = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'tiktok', label: 'TikTok' },
];

const IDIOMAS = [
  { value: 'pt-BR', label: 'Português (Brasil)' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
];

export function BriefingForm({ onSubmit, isLoading = false }: BriefingFormProps) {
  const [tema, setTema] = useState('');
  const [procedimento, setProcedimento] = useState('');
  const [redesSociais, setRedesSociais] = useState<RedeSocial[]>([]);
  const [publicoAlvoOverride, setPublicoAlvoOverride] = useState('');
  const [idioma, setIdioma] = useState('pt-BR');
  const [errors, setErrors] = useState<FormErrors>({});

  function validateForm(): boolean {
    const newErrors: FormErrors = {};

    if (!tema.trim()) {
      newErrors.tema = 'O tema é obrigatório';
    }

    if (redesSociais.length === 0) {
      newErrors.redesSociais = 'Selecione ao menos uma rede social';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function handleCheckboxToggle(rede: RedeSocial) {
    setRedesSociais((prev) =>
      prev.includes(rede) ? prev.filter((r) => r !== rede) : [...prev, rede],
    );
    if (errors.redesSociais) {
      setErrors((prev) => ({ ...prev, redesSociais: undefined }));
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!validateForm()) return;

    const data: GenerateBriefing = {
      tema: tema.trim(),
      redesSociais,
      idioma,
    };

    // procedimento não é enviado — backend espera UUID de procedimento cadastrado
    // TODO: converter para select de procedimentos quando disponível

    if (publicoAlvoOverride.trim()) {
      data.publicoAlvoOverride = publicoAlvoOverride.trim();
    }

    onSubmit(data);
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Tema (obrigatório) */}
      <div className="space-y-2">
        <Label htmlFor="tema">
          Tema <span className="text-destructive">*</span>
        </Label>
        <Textarea
          id="tema"
          placeholder="Descreva o tema do conteúdo..."
          value={tema}
          onChange={(e) => {
            setTema(e.target.value);
            if (errors.tema) {
              setErrors((prev) => ({ ...prev, tema: undefined }));
            }
          }}
          disabled={isLoading}
          aria-invalid={!!errors.tema}
          rows={3}
        />
        {errors.tema && (
          <p className="text-sm text-destructive">{errors.tema}</p>
        )}
      </div>

      {/* Procedimento (opcional) */}
      <div className="space-y-2">
        <Label htmlFor="procedimento">Procedimento</Label>
        <Input
          id="procedimento"
          placeholder="Ex: Botox, Harmonização facial..."
          value={procedimento}
          onChange={(e) => setProcedimento(e.target.value)}
          disabled={isLoading}
        />
      </div>

      {/* Redes Sociais (obrigatório, ao menos 1) */}
      <fieldset className="space-y-2">
        <legend className="text-sm leading-none font-medium">
          Redes Sociais <span className="text-destructive">*</span>
        </legend>
        <div className="flex flex-wrap gap-4 pt-1">
          {REDES_SOCIAIS.map((rede) => (
            <label
              key={rede.id}
              className="flex items-center gap-2 cursor-pointer"
            >
              <Checkbox
                checked={redesSociais.includes(rede.id)}
                onCheckedChange={() => handleCheckboxToggle(rede.id)}
                disabled={isLoading}
              />
              <span className="text-sm">{rede.label}</span>
            </label>
          ))}
        </div>
        {errors.redesSociais && (
          <p className="text-sm text-destructive">{errors.redesSociais}</p>
        )}
      </fieldset>

      {/* Público-alvo personalizado (opcional) */}
      <div className="space-y-2">
        <Label htmlFor="publicoAlvo">Público-alvo (personalizado)</Label>
        <Textarea
          id="publicoAlvo"
          placeholder="Descreva o público-alvo específico para este conteúdo..."
          value={publicoAlvoOverride}
          onChange={(e) => setPublicoAlvoOverride(e.target.value)}
          disabled={isLoading}
          rows={2}
        />
      </div>

      {/* Idioma (padrão pt-BR) */}
      <div className="space-y-2">
        <Label>Idioma</Label>
        <Select value={idioma} onValueChange={(value) => { if (value) setIdioma(value); }} disabled={isLoading}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Selecione o idioma" />
          </SelectTrigger>
          <SelectContent>
            {IDIOMAS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Botão Gerar */}
      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading && <Loader2 className="mr-2 size-4 animate-spin" />}
        Gerar Conteúdo
      </Button>
    </form>
  );
}
