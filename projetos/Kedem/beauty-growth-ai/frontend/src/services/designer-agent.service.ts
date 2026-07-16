import apiClient from '@/services/api';
import type {
  GenerateFromContentRequest,
  GenerateAcceptedResponse,
  DesignerAgentExecution,
} from '@/types/designer-agent';

export const designerAgentService = {
  fromContent: (data: GenerateFromContentRequest): Promise<GenerateAcceptedResponse> =>
    apiClient.post('/api/designer-agent/from-content', data).then(r => r.data),

  getExecution: (executionId: string): Promise<DesignerAgentExecution> =>
    apiClient.get(`/api/designer-agent/executions/${executionId}`).then(r => r.data),
};
