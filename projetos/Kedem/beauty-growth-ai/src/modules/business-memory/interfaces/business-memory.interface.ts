import { MemoryCategory, BusinessMemoryEntry } from '../entities/business-memory-entry.entity';

export interface BusinessMemorySnapshot {
  tenantId: string;
  categories: Record<MemoryCategory, MemoryEntrySummary[]>;
  lastUpdated: Date | null;
}

export interface MemoryEntrySummary {
  key: string;
  value: any;
  version: number;
  updatedAt: Date;
  updatedBy: string;
}

export interface CampaignMetadata {
  campaignId: string;
  name: string;
  type: string;
  status: 'completed' | 'cancelled';
  startedAt: Date;
  completedAt: Date;
  metrics?: Record<string, any>;
}

export interface IBusinessMemoryService {
  getByTenant(tenantId: string): Promise<BusinessMemoryEntry[]>;
  getByCategory(tenantId: string, category: MemoryCategory): Promise<BusinessMemoryEntry[]>;
  syncFromBrand(tenantId: string, brandData: Record<string, any>): Promise<void>;
  syncFromClinic(tenantId: string, clinicData: Record<string, any>): Promise<void>;
  recordCampaign(tenantId: string, campaign: CampaignMetadata): Promise<void>;
  getSnapshot(tenantId: string): Promise<BusinessMemorySnapshot>;
}

export const BUSINESS_MEMORY_SERVICE = Symbol('BUSINESS_MEMORY_SERVICE');
