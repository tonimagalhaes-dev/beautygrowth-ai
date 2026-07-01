import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { authService } from '@/services/auth.service';
import type { LoginRequest, LoginResponse } from '@/types/auth';

export interface UseAuthReturn {
  isAuthenticated: boolean;
  login: ReturnType<typeof useMutation<LoginResponse, Error, LoginRequest>>;
  logout: () => void;
  isLoading: boolean;
  clinicSetup: boolean | null;
}

export function useAuth(): UseAuthReturn {
  const navigate = useNavigate();

  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(
    () => !!localStorage.getItem('auth_token')
  );

  const [clinicSetup, setClinicSetup] = useState<boolean | null>(null);

  const loginMutation = useMutation<LoginResponse, Error, LoginRequest>({
    mutationFn: authService.login,
    onSuccess: (data) => {
      localStorage.setItem('auth_token', data.token);
      setIsAuthenticated(true);
      setClinicSetup(data.clinicSetup);

      if (data.clinicSetup) {
        navigate('/content');
      } else {
        navigate('/onboarding');
      }
    },
  });

  const logout = useCallback(() => {
    authService.logout();
    setIsAuthenticated(false);
    setClinicSetup(null);
  }, []);

  return {
    isAuthenticated,
    login: loginMutation,
    logout,
    isLoading: loginMutation.isPending,
    clinicSetup,
  };
}
