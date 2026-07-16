import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';

export function ProtectedLayout() {
  const token = localStorage.getItem('auth_token');
  const location = useLocation();
  const navigate = useNavigate();

  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  function handleLogout() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('refresh_token');
    sessionStorage.clear();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between px-4 py-2 border-b border-border bg-card">
        <span className="text-sm font-semibold text-foreground">BeautyGrowth AI</span>
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          <LogOut className="size-4 mr-1" />
          Sair
        </Button>
      </header>
      <main className="h-[calc(100vh-49px)]">
        <Outlet />
      </main>
      <Toaster />
    </div>
  );
}
