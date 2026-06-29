export type Role = 'admin' | 'operator' | 'viewer';

export interface TokenPayload {
  userId: string;
  tenantId: string;
  role: Role;
  iat: number;
  exp: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    role: Role;
    tenantId: string;
  };
  tokens: TokenPair;
}
