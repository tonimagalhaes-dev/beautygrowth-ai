import { createBrowserRouter } from 'react-router-dom';
import { ProtectedLayout } from '@/components/ProtectedLayout';
import { LoginPage } from '@/pages/LoginPage';
import { OnboardingPage } from '@/pages/OnboardingPage';
import { ContentGenerationPage } from '@/pages/ContentGenerationPage';

export const router = createBrowserRouter([
  {
    path: '/login',
    element: <LoginPage />,
  },
  {
    path: '/',
    element: <ProtectedLayout />,
    children: [
      {
        path: 'onboarding',
        element: <OnboardingPage />,
      },
      {
        path: 'content',
        element: <ContentGenerationPage />,
      },
    ],
  },
]);
