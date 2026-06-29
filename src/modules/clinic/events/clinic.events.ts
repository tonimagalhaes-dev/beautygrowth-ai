import { Clinic } from '../entities/clinic.entity';

export const CLINIC_CREATED_EVENT = 'clinic.created';
export const CLINIC_UPDATED_EVENT = 'clinic.updated';

export class ClinicCreatedEvent {
  constructor(public readonly clinic: Clinic) {}
}

export class ClinicUpdatedEvent {
  constructor(
    public readonly clinic: Clinic,
    public readonly updatedFields: string[],
  ) {}
}
