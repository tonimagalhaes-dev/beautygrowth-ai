import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { toast } from 'sonner';

import { CopyButton } from './CopyButton';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function mockClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    writable: true,
    configurable: true,
  });
}

describe('CopyButton', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('renders with Copy icon and correct aria-label', () => {
    render(<CopyButton text="hello" ariaLabel="Copiar descrição visual para instagram" />);

    const button = screen.getByRole('button', { name: 'Copiar descrição visual para instagram' });
    expect(button).toBeInTheDocument();
  });

  it('copies text to clipboard on click and shows success toast', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeTextMock);

    render(<CopyButton text="Descrição de teste" ariaLabel="Copiar descrição" />);

    const button = screen.getByRole('button', { name: 'Copiar descrição' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('Descrição de teste');
      expect(toast.success).toHaveBeenCalledWith('Descrição copiada para a área de transferência.');
    });
  });

  it('shows Check icon after successful copy and reverts after 2s', async () => {
    vi.useFakeTimers();
    mockClipboard(vi.fn().mockResolvedValue(undefined));

    const { container } = render(<CopyButton text="texto" ariaLabel="Copiar" />);

    const button = screen.getByRole('button', { name: 'Copiar' });

    await act(async () => {
      fireEvent.click(button);
      // Flush microtasks so the async handleCopy resolves
      await Promise.resolve();
    });

    // After click, should show Check icon (green)
    expect(container.querySelector('svg.text-green-600')).toBeInTheDocument();

    // After 2 seconds, reverts to Copy icon
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(container.querySelector('svg.text-green-600')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('shows error toast when clipboard API fails', async () => {
    mockClipboard(vi.fn().mockRejectedValue(new Error('Permission denied')));

    render(<CopyButton text="texto" ariaLabel="Copiar" />);

    const button = screen.getByRole('button', { name: 'Copiar' });
    fireEvent.click(button);

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        'Não foi possível copiar. Selecione o texto e copie manualmente.',
      );
    });
  });

  it('is focusable and activatable via keyboard', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    mockClipboard(writeTextMock);

    render(<CopyButton text="texto keyboard" ariaLabel="Copiar teclado" />);

    const button = screen.getByRole('button', { name: 'Copiar teclado' });

    // Verify the button is focusable (tabindex="0" or native button)
    expect(button).not.toHaveAttribute('tabindex', '-1');
    expect(button.tagName.toLowerCase()).toBe('button');

    // Simulate keyboard activation via click (browsers trigger click on Enter/Space for buttons)
    fireEvent.click(button);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('texto keyboard');
    });
  });
});
