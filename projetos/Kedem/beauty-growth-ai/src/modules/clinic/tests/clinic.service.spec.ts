import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { ClinicService } from '../services/clinic.service';
import { Clinic } from '../entities/clinic.entity';
import { CreateClinicDto } from '../dto/create-clinic.dto';
import { UpdateClinicDto } from '../dto/update-clinic.dto';
import { CLINIC_CREATED_EVENT, CLINIC_UPDATED_EVENT } from '../events/clinic.events';
import { SPECIALTIES_CATALOG } from '../constants/specialties';

describe('ClinicService', () => {
  let service: ClinicService;
  let mockRepository: Record<string, jest.Mock>;
  let mockEventEmitter: { emit: jest.Mock };

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const clinicId = '22222222-2222-2222-2222-222222222222';

  const validCreateDto: CreateClinicDto = {
    name: 'Clínica Estética Premium',
    phone: '11999887766',
    email: 'contato@clinicapremium.com.br',
    specialties: ['Botox', 'Harmonização Facial'],
    targetAudience: 'Mulheres 25-45 anos, classe A/B',
  };

  const existingClinic: Partial<Clinic> = {
    id: clinicId,
    tenantId,
    name: 'Clínica Original',
    phone: '11988776655',
    email: 'original@clinica.com',
    specialties: ['Botox'],
    targetAudience: 'Mulheres 30-50',
    address: null,
    website: null,
    version: 1,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
  };

  beforeEach(async () => {
    mockRepository = {
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClinicService,
        {
          provide: getRepositoryToken(Clinic),
          useValue: mockRepository,
        },
        {
          provide: EventEmitter2,
          useValue: mockEventEmitter,
        },
      ],
    }).compile();

    service = module.get<ClinicService>(ClinicService);
  });

  describe('create', () => {
    it('should create a clinic and emit CLINIC_CREATED event', async () => {
      const createdClinic = {
        id: clinicId,
        tenantId,
        ...validCreateDto,
        address: null,
        website: null,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockRepository.create.mockReturnValue(createdClinic);
      mockRepository.save.mockResolvedValue(createdClinic);

      const result = await service.create(tenantId, validCreateDto);

      expect(result).toEqual(createdClinic);
      expect(mockRepository.create).toHaveBeenCalledWith({
        tenantId,
        name: validCreateDto.name,
        phone: validCreateDto.phone,
        email: validCreateDto.email,
        specialties: validCreateDto.specialties,
        targetAudience: validCreateDto.targetAudience,
        address: null,
        website: null,
      });
      expect(mockRepository.save).toHaveBeenCalledWith(createdClinic);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CLINIC_CREATED_EVENT,
        expect.objectContaining({ clinic: createdClinic }),
      );
    });

    it('should create a clinic with optional address and website', async () => {
      const dtoWithOptionals: CreateClinicDto = {
        ...validCreateDto,
        address: { street: 'Rua das Flores', number: '123', city: 'São Paulo', state: 'SP', zipCode: '01234567' },
        website: 'https://clinicapremium.com.br',
      };

      const createdClinic = {
        id: clinicId,
        tenantId,
        ...dtoWithOptionals,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockRepository.create.mockReturnValue(createdClinic);
      mockRepository.save.mockResolvedValue(createdClinic);

      const result = await service.create(tenantId, dtoWithOptionals);

      expect(result.address).toEqual(dtoWithOptionals.address);
      expect(result.website).toBe(dtoWithOptionals.website);
    });
  });

  describe('update', () => {
    it('should update a clinic and emit CLINIC_UPDATED event', async () => {
      mockRepository.findOne.mockResolvedValue({ ...existingClinic });

      const updateDto: UpdateClinicDto = {
        name: 'Clínica Atualizada',
        version: 1,
      };

      const updatedClinic = { ...existingClinic, name: 'Clínica Atualizada', version: 2 };
      mockRepository.save.mockResolvedValue(updatedClinic);

      const result = await service.update(clinicId, tenantId, updateDto);

      expect(result.name).toBe('Clínica Atualizada');
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CLINIC_UPDATED_EVENT,
        expect.objectContaining({
          clinic: updatedClinic,
          updatedFields: ['name'],
        }),
      );
    });

    it('should throw NotFoundException if clinic does not exist', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      const updateDto: UpdateClinicDto = { name: 'Test', version: 1 };

      await expect(
        service.update(clinicId, tenantId, updateDto),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw ConflictException on version mismatch (optimistic locking)', async () => {
      mockRepository.findOne.mockResolvedValue({ ...existingClinic, version: 2 });

      const updateDto: UpdateClinicDto = { name: 'Test', version: 1 };

      await expect(
        service.update(clinicId, tenantId, updateDto),
      ).rejects.toThrow(ConflictException);
    });

    it('should only update provided fields', async () => {
      mockRepository.findOne.mockResolvedValue({ ...existingClinic });

      const updateDto: UpdateClinicDto = {
        phone: '11912345678',
        email: 'novo@email.com',
        version: 1,
      };

      mockRepository.save.mockImplementation((clinic) => Promise.resolve(clinic));

      const result = await service.update(clinicId, tenantId, updateDto);

      expect(result.phone).toBe('11912345678');
      expect(result.email).toBe('novo@email.com');
      expect(result.name).toBe('Clínica Original'); // unchanged
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        CLINIC_UPDATED_EVENT,
        expect.objectContaining({
          updatedFields: ['phone', 'email'],
        }),
      );
    });
  });

  describe('getByTenant', () => {
    it('should return the clinic for a given tenant', async () => {
      mockRepository.findOne.mockResolvedValue(existingClinic);

      const result = await service.getByTenant(tenantId);

      expect(result).toEqual(existingClinic);
      expect(mockRepository.findOne).toHaveBeenCalledWith({
        where: { tenantId },
      });
    });

    it('should throw NotFoundException if no clinic exists for tenant', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.getByTenant(tenantId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getSpecialties', () => {
    it('should return the full predefined specialties catalog', () => {
      const specialties = service.getSpecialties();

      expect(specialties).toHaveLength(SPECIALTIES_CATALOG.length);
      expect(specialties).toEqual([...SPECIALTIES_CATALOG]);
    });

    it('should return a copy (not the original reference)', () => {
      const specialties = service.getSpecialties();
      specialties.push('Invalid Specialty');

      expect(service.getSpecialties()).toHaveLength(SPECIALTIES_CATALOG.length);
    });
  });
});
