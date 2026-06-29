import { AgentConfig } from '../entities/agent-config.entity';
import { ConfigChange } from '../entities/config-change.entity';
import { UpdateAgentConfigDto } from '../dto/update-agent-config.dto';

export const AGENT_CONFIG_SERVICE = 'AGENT_CONFIG_SERVICE';

export interface IAgentConfigService {
  provisionDefaults(tenantId: string): Promise<AgentConfig[]>;
  list(tenantId: string): Promise<AgentConfig[]>;
  update(agentId: string, dto: UpdateAgentConfigDto, userId: string): Promise<AgentConfig>;
  activate(agentId: string): Promise<void>;
  deactivate(agentId: string): Promise<void>;
  resetToDefaults(agentId: string): Promise<AgentConfig>;
  getConfigHistory(agentId: string): Promise<ConfigChange[]>;
}
