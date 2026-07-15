import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { DesignerAgentService } from './services/designer-agent.service';
import { GenerateImageDto } from './dto/generate-image.dto';
import { EditImageDto } from './dto/edit-image.dto';
import { FromContentDto } from './dto/from-content.dto';
import {
  DesignerAgentResponse,
  GenerateAcceptedResponse,
} from './dto/designer-agent-response.dto';
import { CurrentTenant } from '@shared/decorators';
import { TenantContext } from '@shared/interfaces';
import { TenantGuard } from '@shared/guards/tenant.guard';

@Controller('designer-agent')
@UseGuards(TenantGuard)
export class DesignerAgentController {
  constructor(
    private readonly designerAgentService: DesignerAgentService,
  ) {}

  /**
   * POST /api/designer-agent/generate
   * Initiates image generation based on a visual description.
   * Returns 202 Accepted with execution_id for polling.
   * Propagates X-Trace-Id header (or generates UUID v4 if absent).
   */
  @Post('generate')
  @HttpCode(HttpStatus.ACCEPTED)
  async generate(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: GenerateImageDto,
    @Headers('x-trace-id') traceId?: string,
  ): Promise<GenerateAcceptedResponse> {
    return this.designerAgentService.generate(
      dto,
      tenant.tenantId,
      tenant.userId,
      traceId,
    );
  }

  /**
   * POST /api/designer-agent/edit
   * Performs iterative editing on a previously generated image.
   * Propagates X-Trace-Id header (or generates UUID v4 if absent).
   */
  @Post('edit')
  @HttpCode(HttpStatus.OK)
  async edit(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: EditImageDto,
    @Headers('x-trace-id') traceId?: string,
  ): Promise<DesignerAgentResponse> {
    return this.designerAgentService.edit(
      dto,
      tenant.tenantId,
      tenant.userId,
      traceId,
    );
  }

  /**
   * GET /api/designer-agent/executions/:id
   * Retrieves the current status and results of an execution.
   */
  @Get('executions/:id')
  async getExecution(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<DesignerAgentResponse> {
    return this.designerAgentService.getExecution(id, tenant.tenantId);
  }

  /**
   * GET /api/designer-agent/executions/:id/images/:imageId/download
   * Returns a download URL for a specific image.
   */
  @Get('executions/:id/images/:imageId/download')
  async getDownloadUrl(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('imageId', new ParseUUIDPipe({ version: '4' })) imageId: string,
  ): Promise<{ url: string }> {
    const url = await this.designerAgentService.getDownloadUrl(
      id,
      imageId,
      tenant.tenantId,
    );
    return { url };
  }

  /**
   * POST /api/designer-agent/from-content
   * Generates images from a Content Agent execution.
   * Returns 202 Accepted with execution_id for polling.
   * Propagates X-Trace-Id header (or generates UUID v4 if absent).
   */
  @Post('from-content')
  @HttpCode(HttpStatus.ACCEPTED)
  async fromContent(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: FromContentDto,
    @Headers('x-trace-id') traceId?: string,
  ): Promise<GenerateAcceptedResponse> {
    return this.designerAgentService.fromContent(
      dto,
      tenant.tenantId,
      tenant.userId,
      traceId,
    );
  }
}
