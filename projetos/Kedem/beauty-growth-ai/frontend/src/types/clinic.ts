export interface Clinic {
  id: string;
  nome: string;
  telefone: string;
  email: string;
  especialidades: string[];
  publicoAlvo: string;
}

export interface CreateClinicRequest {
  nome: string;
  telefone: string;
  email: string;
  especialidades: string[];
  publicoAlvo: string;
}

export interface BrandIdentity {
  id: string;
  tomDeVoz: string;
  paletaDeCores: string[];
  logotipoUrl?: string;
  publicoAlvo: string;
  diferenciais: string[];
  valores: string[];
}

export interface CreateBrandRequest {
  tomDeVoz: string;
  paletaDeCores: string[];
  logotipo?: File;
  publicoAlvo: string;
  diferenciais: string[];
  valores: string[];
}
