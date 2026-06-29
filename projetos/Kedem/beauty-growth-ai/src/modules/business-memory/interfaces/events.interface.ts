export const BRAND_UPDATED_EVENT = 'brand.updated';
export const CLINIC_CREATED_EVENT = 'clinic.created';
export const CLINIC_UPDATED_EVENT = 'clinic.updated';
export const CAMPAIGN_COMPLETED_EVENT = 'campaign.completed';

export interface BrandUpdatedPayload {
  tenantId: string;
  brandId: string;
  action: 'created' | 'updated';
  timestamp: Date;
}

export interface ClinicCreatedPayload {
  clinic: {
    tenantId: string;
    name: string;
    phone: string;
    email: string;
    specialties: string[];
    targetAudience: string;
    address?: any;
    website?: string | null;
  };
}

export interface ClinicUpdatedPayload {
  clinic: {
    tenantId: string;
    name: string;
    phone: string;
    email: string;
    specialties: string[];
    targetAudience: string;
    address?: any;
    website?: string | null;
  };
  updatedFields: string[];
}

export interface CampaignCompletedPayload {
  tenantId: string;
  campaignId: string;
  name: string;
  type: string;
  status: 'completed' | 'cancelled';
  startedAt: Date;
  completedAt: Date;
  metrics?: Record<string, any>;
}
