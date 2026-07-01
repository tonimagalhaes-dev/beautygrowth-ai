import apiClient from '@/services/api';
import type { GenerateBriefing, ContentAgentResult, RefineRequest } from '@/types/content-agent';

export const contentAgentService = {
  generate: (data: GenerateBriefing): Promise<ContentAgentResult> =>
    apiClient.post('/api/content-agent/generate', data).then(r => r.data),

  refine: (data: RefineRequest): Promise<ContentAgentResult> =>
    apiClient.post('/api/content-agent/refine', data).then(r => r.data),
};
