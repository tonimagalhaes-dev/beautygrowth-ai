import { Prompt, PromptVersion } from '../entities';
import { CreatePromptDto } from '../dto/create-prompt.dto';
import { UpdatePromptDto } from '../dto/update-prompt.dto';

/**
 * Resolved prompt with variable substitution results.
 */
export interface ResolvedPrompt {
  content: string; // variables resolved
  version: string;
  resolvedVariables: Record<string, string>;
  unresolvedVariables: string[]; // variables without value in tenant context
}

/**
 * Result of sandbox testing a prompt version.
 */
export interface SandboxResult {
  resolvedContent: string;
  version: string;
  resolvedVariables: Record<string, string>;
  unresolvedVariables: string[];
  isProduction: false;
}

/**
 * Prompt Registry Service interface.
 */
export interface IPromptRegistryService {
  create(dto: CreatePromptDto, authorId: string | null): Promise<Prompt>;
  update(promptId: string, dto: UpdatePromptDto, authorId: string | null): Promise<PromptVersion>;
  getActive(promptId: string): Promise<ResolvedPrompt>;
  rollback(promptId: string, version: string): Promise<void>;
  resolve(promptId: string, tenantContext: Record<string, string>): Promise<ResolvedPrompt>;
  testInSandbox(promptId: string, version: string, context: Record<string, string>): Promise<SandboxResult>;
  listVersions(promptId: string): Promise<PromptVersion[]>;
}
