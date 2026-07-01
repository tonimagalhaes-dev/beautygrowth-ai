import { useMutation, useQuery } from '@tanstack/react-query';
import { clinicService } from '@/services/clinic.service';
import type { CreateClinicRequest, CreateBrandRequest } from '@/types/clinic';

export function useClinic(options?: { statusEnabled?: boolean }) {
  const createClinic = useMutation({
    mutationFn: (data: CreateClinicRequest) => clinicService.create(data),
  });

  const createBrand = useMutation({
    mutationFn: (data: CreateBrandRequest) => clinicService.createBrand(data),
  });

  const clinicStatus = useQuery({
    queryKey: ['clinic', 'status'],
    queryFn: () => clinicService.getStatus(),
    enabled: options?.statusEnabled ?? true,
  });

  return {
    createClinic,
    createBrand,
    clinicStatus,
  };
}
