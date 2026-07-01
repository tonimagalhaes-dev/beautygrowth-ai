export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'operator' | 'viewer';
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: User;
  clinicSetup: boolean;
}

export interface AuthState {
  token: string | null;
  user: User | null;
  clinicSetup: boolean;
}
