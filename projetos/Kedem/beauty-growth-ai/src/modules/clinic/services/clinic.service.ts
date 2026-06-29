import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { Clinic } from '../entities/clinic.entity';
import { CreateClinicDto } from '../dto/create-clinic.dto';
import { UpdateClinicDto } from '../dto/update-clinic.dto';
import { SPECIALTIES_CATALOG, Specialty } from '../constants/specialties';
import {
  CLINIC_CREATED_EVENT,
  CLINIC_UPDATED_EVENT,
  ClinicCreatedEvent,
  ClinicUpdatedEvent,
} from '../events/clinic.events';

@Injectable()
export class ClinicService {
  private readonly logger = new Logger(ClinicService.name);

  constructor(
    @InjectRepository(Clinic)
    private readonly clinicRepository: Repository<Clinic>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Create a new clinic for a given tenant.
   */
  async create(tenantId: string, dto: CreateClinicDto): Promise<Clinic> {
    const clinic = this.clinicRepository.create({
      tenantId,
      name: dto.name,
      phone: dto.phone,
      email: dto.email,
      specialties: dto.specialties,
      targetAudience: dto.targetAudience,
      address: dto.address || null,
      website: dto.website || null,
    });

    const saved = await this.clinicRepository.save(clinic);

    this.logger.log(`Clinic created: ${saved.id} for tenant: ${tenantId}`);

    // Emit event for Business Memory sync (within 30s SLA)
    this.eventEmitter.emit(CLINIC_CREATED_EVENT, new ClinicCreatedEvent(saved));

    return saved;
  }

  /**
   * Update an existing clinic with optimistic locking.
   * The client must send the current `version` to detect conflicts.
   */
  async update(clinicId: string, tenantId: string, dto: UpdateClinicDto): Promise<Clinic> {
    const clinic = await this.clinicRepository.findOne({
      where: { id: clinicId, tenantId },
    });

    if (!clinic) {
      throw new NotFoundException(`Clínica com ID ${clinicId} não encontrada`);
    }

    // Optimistic locking check
    if (clinic.version !== dto.version) {
      throw new ConflictException(
        'Os dados da clínica foram alterados por outro usuário. Por favor, recarregue e tente novamente.',
      );
    }

    const updatedFields: string[] = [];

    if (dto.name !== undefined) {
      clinic.name = dto.name;
      updatedFields.push('name');
    }
    if (dto.phone !== undefined) {
      clinic.phone = dto.phone;
      updatedFields.push('phone');
    }
    if (dto.email !== undefined) {
      clinic.email = dto.email;
      updatedFields.push('email');
    }
    if (dto.specialties !== undefined) {
      clinic.specialties = dto.specialties;
      updatedFields.push('specialties');
    }
    if (dto.targetAudience !== undefined) {
      clinic.targetAudience = dto.targetAudience;
      updatedFields.push('targetAudience');
    }
    if (dto.address !== undefined) {
      clinic.address = dto.address;
      updatedFields.push('address');
    }
    if (dto.website !== undefined) {
      clinic.website = dto.website;
      updatedFields.push('website');
    }

    const saved = await this.clinicRepository.save(clinic);

    this.logger.log(
      `Clinic updated: ${saved.id}, fields: ${updatedFields.join(', ')}`,
    );

    // Emit event for Business Memory sync
    this.eventEmitter.emit(
      CLINIC_UPDATED_EVENT,
      new ClinicUpdatedEvent(saved, updatedFields),
    );

    return saved;
  }

  /**
   * Get clinic by tenant ID.
   */
  async getByTenant(tenantId: string): Promise<Clinic> {
    const clinic = await this.clinicRepository.findOne({
      where: { tenantId },
    });

    if (!clinic) {
      throw new NotFoundException(
        `Nenhuma clínica encontrada para o tenant ${tenantId}`,
      );
    }

    return clinic;
  }

  /**
   * Returns the predefined specialties catalog.
   */
  getSpecialties(): Specialty[] {
    return [...SPECIALTIES_CATALOG];
  }
}
