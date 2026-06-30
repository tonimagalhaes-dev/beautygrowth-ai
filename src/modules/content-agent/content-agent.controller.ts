import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ContentAgentService } from './services/content-agent.service';
import { GenerateBriefingDto } from './dto/generate-briefing.dto';
import { RefineBriefingDto } from './dto/refine-briefing.dto';
import { ContentAgentResponse } from './dto/content-agent-response.dto';
import { CurrentTenant } from '@shared/decorators';
import { TenantContext } from '@shared/interfaces';
import { TenantGuard } from '@shared/guards/tenant.guard';

@Controller('api/content-agent')
@UseGuards(TenantGuard)
export class ContentAgentController {
  constructor(private readonly contentAgentService: ContentAgentService) {}

  /**
   * POST /api/content-agent/generate
   * Generates content based on a briefing for the authenticated tenant.
   */
  @Post('generate')
  @HttpCode(HttpStatus.OK)
  async generate(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: GenerateBriefingDto,
  ): Promise<ContentAgentResponse> {
    return this.contentAgentService.generate(
      dto,
      tenant.tenantId,
      tenant.userId,
    );
  }

  /**
   * POST /api/content-agent/refine
   * Refines previously generated content for the authenticated tenant.
   */
  @Post('refine')
  @HttpCode(HttpStatus.OK)
  async refine(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: RefineBriefingDto,
  ): Promise<ContentAgentResponse> {
    return this.contentAgentService.refine(
      dto,
      tenant.tenantId,
      tenant.userId,
    );
  }
}
