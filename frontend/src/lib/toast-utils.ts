import { AxiosError } from 'axios';
import { toast } from 'sonner';

/**
 * Exibe um toast de erro com tratamento específico por status code.
 *
 * - 422: Exibe a mensagem retornada pela API diretamente
 * - 429: "Limite atingido. Tente novamente mais tarde."
 * - 503: "Serviço temporariamente indisponível. Tente novamente em alguns minutos."
 * - Erro de rede (sem response): "Erro de conexão. Verifique sua internet e tente novamente."
 * - Outros: "Erro inesperado. Tente novamente."
 *
 * @param error - O erro capturado (pode ser AxiosError ou qualquer outro tipo)
 */
export function showErrorToast(error: unknown): void {
  const fallbackMessage = 'Erro inesperado. Tente novamente.';

  if (!(error instanceof AxiosError)) {
    toast.error(fallbackMessage);
    return;
  }

  // Erro de rede — sem response do servidor
  if (!error.response || error.code === 'ERR_NETWORK') {
    toast.error('Erro de conexão. Verifique sua internet e tente novamente.');
    return;
  }

  const status = error.response.status;

  switch (status) {
    case 422: {
      const apiMessage = error.response.data?.message;
      const message =
        typeof apiMessage === 'string' && apiMessage.length > 0
          ? apiMessage
          : fallbackMessage;
      toast.error(message);
      break;
    }
    case 429:
      toast.error('Limite atingido. Tente novamente mais tarde.');
      break;
    case 503:
      toast.error(
        'Serviço temporariamente indisponível. Tente novamente em alguns minutos.',
      );
      break;
    default: {
      const apiMessage = error.response.data?.message;
      const message =
        typeof apiMessage === 'string' && apiMessage.length > 0
          ? apiMessage
          : fallbackMessage;
      toast.error(message);
      break;
    }
  }
}
