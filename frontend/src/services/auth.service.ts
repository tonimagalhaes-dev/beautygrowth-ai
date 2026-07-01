import apiClient from '@/services/api';
import type { LoginRequest, LoginResponse } from '@/types/auth';

export const authService = {
  login: (data: LoginRequest): Promise<LoginResponse> =>
    apiClient.post('/api/auth/login', data).then((r) => r.data),

  logout: (): void => {
    localStorage.removeItem('auth_token');
    window.location.href = '/login';
  },
};
