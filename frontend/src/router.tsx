import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedLayout } from '@/components/ProtectedLayout';
import { LoginPage } from '@/pages/LoginPage';
import { OnboardingPage } from '@/pages/OnboardingPage';
import { ContentGenerationPage } from '@/pages/ContentGenerationPage';

export function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<ProtectedLayout />}>
          <Route index element={<Navigate to="/content" replace />} />
          <Route path="onboarding" element={<OnboardingPage />} />
          <Route path="content" element={<ContentGenerationPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
