import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { BrandService } from './services/brand.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { SuggestOptionsDto } from './dto/suggest-options.dto';
import { BrandIdentity } from './entities/brand-identity.entity';
import { LogoUploadResult } from './interfaces/brand.interface';

@Controller('brand')
export class BrandController {
  constructor(private readonly brandService: BrandService) {}

  /**
   * POST /brand
   * Creates brand identity for the current tenant.
   * In production, tenantId would come from @CurrentTenant() decorator.
   */
  @Post()
  async create(
    @Body() dto: CreateBrandDto,
    // TODO: Replace with @CurrentTenant() decorator when integrated
    @Body('tenantId') tenantId?: string,
  ): Promise<BrandIdentity> {
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    return this.brandService.create(tenantId, dto);
  }

  /**
   * PATCH /brand/:id
   * Updates brand identity.
   */
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateBrandDto,
    // TODO: Replace with @CurrentTenant() decorator when integrated
    @Body('tenantId') tenantId?: string,
  ): Promise<BrandIdentity> {
    if (!tenantId) {
      throw new BadRequestException('tenantId is required');
    }
    return this.brandService.update(id, tenantId, dto);
  }

  /**
   * GET /brand/tenant/:tenantId
   * Gets brand identity for a tenant.
   */
  @Get('tenant/:tenantId')
  async getByTenant(@Param('tenantId') tenantId: string): Promise<BrandIdentity | null> {
    return this.brandService.getByTenant(tenantId);
  }

  /**
   * POST /brand/logo
   * Uploads a logo file with format, size and dimension validation.
   */
  @Post('logo')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file'))
  async uploadLogo(
    @UploadedFile() file: Express.Multer.File,
  ): Promise<LogoUploadResult> {
    if (!file) {
      throw new BadRequestException('File is required');
    }
    return this.brandService.uploadLogo(file);
  }

  /**
   * POST /brand/suggest
   * Returns AI-powered suggestions for brand identity fields.
   */
  @Post('suggest')
  @HttpCode(HttpStatus.OK)
  async suggestOptions(@Body() dto: SuggestOptionsDto): Promise<{ suggestions: string[] }> {
    const suggestions = await this.brandService.suggestOptions(dto.field, {
      clinicName: dto.clinicName,
      specialties: dto.specialties,
      targetAudience: dto.targetAudience,
    });
    return { suggestions };
  }
}
