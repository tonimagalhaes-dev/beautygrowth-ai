import { useState } from "react";
import { AxiosError } from "axios";
import { Loader2 } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { useAuth } from "@/hooks/useAuth";

interface FormErrors {
  email?: string;
  password?: string;
  general?: string;
}

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});

  const { login, isLoading } = useAuth();

  function validateForm(): boolean {
    const newErrors: FormErrors = {};

    if (!email.trim()) {
      newErrors.email = "E-mail é obrigatório";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = "Formato de e-mail inválido";
    }

    if (!password.trim()) {
      newErrors.password = "Senha é obrigatória";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Limpa erro geral anterior
    setErrors((prev) => ({ ...prev, general: undefined }));

    if (!validateForm()) return;

    login.mutate(
      { email: email.trim(), password },
      {
        onError: (error) => {
          const axiosError = error as AxiosError<{ message?: string }>;
          if (axiosError.response?.status === 401) {
            setErrors((prev) => ({
              ...prev,
              general: "Credenciais inválidas",
            }));
          } else {
            setErrors((prev) => ({
              ...prev,
              general:
                axiosError.response?.data?.message ||
                "Erro ao fazer login. Tente novamente.",
            }));
          }
        },
      }
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="mx-4 w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">
            BeautyGrowth AI
          </CardTitle>
          <CardDescription>Faça login para continuar</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {errors.general && (
              <p className="text-sm text-destructive text-center">
                {errors.general}
              </p>
            )}

            <div className="space-y-2">
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                type="email"
                placeholder="seu@email.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (errors.email) {
                    setErrors((prev) => ({ ...prev, email: undefined }));
                  }
                }}
                disabled={isLoading}
                aria-invalid={!!errors.email}
                required
              />
              {errors.email && (
                <p className="text-sm text-destructive">{errors.email}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Senha</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (errors.password) {
                    setErrors((prev) => ({ ...prev, password: undefined }));
                  }
                }}
                disabled={isLoading}
                aria-invalid={!!errors.password}
                required
              />
              {errors.password && (
                <p className="text-sm text-destructive">{errors.password}</p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isLoading}
            >
              {isLoading && (
                <Loader2 className="mr-2 size-4 animate-spin" />
              )}
              Entrar
            </Button>
          </form>
        </CardContent>
      </Card>
      <Toaster />
    </div>
  );
}
