export { ClinicModule } from './clinic.module';
export { ClinicService } from './services/clinic.service';
export { ClinicController } from './clinic.controller';
export { Clinic } from './entities/clinic.entity';
export { CreateClinicDto, UpdateClinicDto, AddressDto } from './dto';
export { SPECIALTIES_CATALOG, Specialty } from './constants/specialties';
export {
  CLINIC_CREATED_EVENT,
  CLINIC_UPDATED_EVENT,
  ClinicCreatedEvent,
  ClinicUpdatedEvent,
} from './events/clinic.events';
