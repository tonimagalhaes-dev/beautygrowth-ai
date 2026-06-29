import { BrandIdentity, ColorEntry } from '../entities/brand-identity.entity';

export interface LogoUploadResult {
  url: string;
  format: 'png' | 'jpg' | 'svg';
  sizeBytes: number;
  dimensions: { width: number; height: number };
}

export interface ClinicContext {
  clinicName: string;
  specialties: string[];
  targetAudience?: string;
}

export interface IBrandService {
  create(tenantId: string, dto: CreateBrandInput): Promise<BrandIdentity>;
  update(brandId: string, tenantId: string, dto: UpdateBrandInput): Promise<BrandIdentity>;
  getByTenant(tenantId: string): Promise<BrandIdentity | null>;
  uploadLogo(file: Express.Multer.File): Promise<LogoUploadResult>;
  suggestOptions(field: string, context: ClinicContext): Promise<string[]>;
}

export interface CreateBrandInput {
  voiceTone: string;
  colorPalette: ColorEntry[];
  targetAudience: string;
  differentials: string[];
  values: string[];
  logo?: string;
}

export interface UpdateBrandInput {
  voiceTone?: string;
  colorPalette?: ColorEntry[];
  targetAudience?: string;
  differentials?: string[];
  values?: string[];
  logo?: string;
}

export interface IStorageService {
  upload(file: Buffer, key: string, contentType: string): Promise<string>;
  delete(key: string): Promise<void>;
  getUrl(key: string): string;
}

export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');
export const BRAND_SERVICE = Symbol('BRAND_SERVICE');
