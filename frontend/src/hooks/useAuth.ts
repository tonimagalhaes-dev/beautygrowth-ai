import { useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { authService } from '@/services/auth.service';
import { clinicService } from '@/services/clinic.service';
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
    onSuccess: async (data) => {
      localStorage.setItem('auth_token', data.accessToken);
      setIsAuthenticated(true);

      // Check if clinic is already set up
      try {
        await clinicService.getMyClinic();
        // Clinic exists — go to content generation
        setClinicSetup(true);
        navigate('/content');
      } catch {
        // No clinic yet (404 or error) — go to onboarding
        setClinicSetup(false);
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
