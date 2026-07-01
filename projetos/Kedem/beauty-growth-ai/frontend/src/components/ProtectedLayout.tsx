import { Navigate, Outlet } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';

export function ProtectedLayout() {
  const token = localStorage.getItem('auth_token');

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return (
    <div className="min-h-screen">
      <Outlet />
      <Toaster />
    </div>
  );
}
