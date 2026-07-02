import apiClient from '@/services/api';
import type { CreateClinicRequest, CreateBrandRequest } from '@/types/clinic';

export const clinicService = {
  create: (data: CreateClinicRequest): Promise<{ id: string }> => {
    // Map frontend PT-BR field names to backend EN field names
    const payload = {
      name: data.nome,
      phone: data.telefone.replace(/\D/g, ''), // Backend expects digits only
      email: data.email,
      specialties: data.especialidades,
      targetAudience: data.publicoAlvo,
    };
    return apiClient.post('/api/clinics', payload).then(r => r.data);
  },

  createBrand: async (data: CreateBrandRequest): Promise<{ id: string }> => {
    // Extract tenantId from JWT token payload
    const token = localStorage.getItem('auth_token');
    let tenantId = '';
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        tenantId = payload.tenantId || '';
      } catch { /* ignore parse errors */ }
    }

    // Map frontend PT-BR fields to backend EN fields (JSON, not FormData)
    const payload = {
      voiceTone: data.tomDeVoz,
      colorPalette: data.paletaDeCores.map((hex, index) => ({
        hex,
        name: `Cor ${index + 1}`,
        isPrimary: index === 0,
      })),
      targetAudience: data.publicoAlvo,
      differentials: data.diferenciais,
      values: data.valores,
      tenantId,
    };

    const result = await apiClient.post('/api/brand', payload).then(r => r.data);

    // Upload logo separately if provided
    if (data.logotipo) {
      const formData = new FormData();
      formData.append('file', data.logotipo);
      await apiClient.post('/api/brand/logo', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    }

    return result;
  },

  getStatus: (): Promise<{ clinicSetup: boolean }> =>
    apiClient.get('/api/clinics/me/status').then(r => r.data),

  getMyClinic: (): Promise<unknown> =>
    apiClient.get('/api/clinics/me').then(r => r.data),
};
