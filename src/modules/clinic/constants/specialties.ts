/**
 * Predefined catalog of aesthetic procedure specialties
 * available for clinics to select from.
 */
export const SPECIALTIES_CATALOG: readonly string[] = [
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
  'Otomodelação',
  'Massagem Modeladora',
  'Tratamento de Acne',
  'Tratamento de Melasma',
  'Tratamento de Estrias',
  'Tratamento de Celulite',
  'Tratamento Capilar',
] as const;

export type Specialty = (typeof SPECIALTIES_CATALOG)[number];
