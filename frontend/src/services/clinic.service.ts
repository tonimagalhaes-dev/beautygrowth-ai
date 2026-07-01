import apiClient from '@/services/api';
import type { CreateClinicRequest, CreateBrandRequest } from '@/types/clinic';

export const clinicService = {
  create: (data: CreateClinicRequest): Promise<{ id: string }> =>
    apiClient.post('/api/clinics', data).then(r => r.data),

  createBrand: (data: CreateBrandRequest): Promise<{ id: string }> => {
    const formData = new FormData();
    formData.append('tomDeVoz', data.tomDeVoz);
    formData.append('paletaDeCores', JSON.stringify(data.paletaDeCores));
    formData.append('publicoAlvo', data.publicoAlvo);
    formData.append('diferenciais', JSON.stringify(data.diferenciais));
    formData.append('valores', JSON.stringify(data.valores));
    if (data.logotipo) formData.append('logotipo', data.logotipo);
    return apiClient.post('/api/brands', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }).then(r => r.data);
  },

  getStatus: (): Promise<{ clinicSetup: boolean }> =>
    apiClient.get('/api/clinics/me/status').then(r => r.data),
};
