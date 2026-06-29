import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ClinicService } from './services/clinic.service';
import { CreateClinicDto } from './dto/create-clinic.dto';
import { UpdateClinicDto } from './dto/update-clinic.dto';
import { Clinic } from './entities/clinic.entity';
import { CurrentTenant } from '@shared/decorators/current-tenant.decorator';
import { TenantContext } from '@shared/interfaces/tenant-context.interface';
import { TenantGuard } from '@shared/guards/tenant.guard';
import { Specialty } from './constants/specialties';

@Controller('clinics')
@UseGuards(TenantGuard)
export class ClinicController {
  constructor(private readonly clinicService: ClinicService) {}

  /**
   * POST /clinics
   * Creates a new clinic for the authenticated tenant.
   */
  @Post()
  async create(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: CreateClinicDto,
  ): Promise<Clinic> {
    return this.clinicService.create(tenant.tenantId, dto);
  }

  /**
   * PATCH /clinics/:id
   * Updates an existing clinic with optimistic locking.
   */
  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(
    @CurrentTenant() tenant: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateClinicDto,
  ): Promise<Clinic> {
    return this.clinicService.update(id, tenant.tenantId, dto);
  }

  /**
   * GET /clinics/me
   * Gets the clinic for the authenticated tenant.
   */
  @Get('me')
  async getMyClinic(@CurrentTenant() tenant: TenantContext): Promise<Clinic> {
    return this.clinicService.getByTenant(tenant.tenantId);
  }

  /**
   * GET /clinics/specialties
   * Returns the predefined specialties catalog.
   */
  @Get('specialties')
  getSpecialties(): Specialty[] {
    return this.clinicService.getSpecialties();
  }
}
