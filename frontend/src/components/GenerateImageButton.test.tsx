import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { GenerateImageButton } from './GenerateImageButton';

describe('GenerateImageButton', () => {
  it('renders "Gerar Imagem" when idle without result', () => {
    render(
      <GenerateImageButton
        onClick={vi.fn()}
        isLoading={false}
        isProcessing={false}
        hasResult={false}
      />
    );

    expect(screen.getByRole('button', { name: /gerar imagem/i })).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeEnabled();
  });

  it('renders "Gerar Nova Imagem" when idle with result', () => {
    render(
      <GenerateImageButton
        onClick={vi.fn()}
        isLoading={false}
        isProcessing={false}
        hasResult={true}
      />
    );

    expect(screen.getByRole('button', { name: /gerar nova imagem/i })).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeEnabled();
  });

  it('renders "Gerando..." and is disabled when isLoading', () => {
    render(
      <GenerateImageButton
        onClick={vi.fn()}
        isLoading={true}
        isProcessing={false}
        hasResult={false}
      />
    );

    expect(screen.getByRole('button', { name: /gerando/i })).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('renders "Gerando..." and is disabled when isProcessing', () => {
    render(
      <GenerateImageButton
        onClick={vi.fn()}
        isLoading={false}
        isProcessing={true}
        hasResult={false}
      />
    );

    expect(screen.getByRole('button', { name: /gerando/i })).toBeInTheDocument();
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('shows spinner icon when loading', () => {
    const { container } = render(
      <GenerateImageButton
        onClick={vi.fn()}
        isLoading={true}
        isProcessing={false}
        hasResult={false}
      />
    );

    const spinner = container.querySelector('.animate-spin');
    expect(spinner).toBeInTheDocument();
  });

  it('calls onClick when clicked in idle state', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(
      <GenerateImageButton
        onClick={onClick}
        isLoading={false}
        isProcessing={false}
        hasResult={false}
      />
    );

    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not call onClick when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(
      <GenerateImageButton
        onClick={onClick}
        isLoading={false}
        isProcessing={false}
        hasResult={false}
        disabled={true}
      />
    );

    await user.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is disabled when disabled prop is true even in idle state', () => {
    render(
      <GenerateImageButton
        onClick={vi.fn()}
        isLoading={false}
        isProcessing={false}
        hasResult={false}
        disabled={true}
      />
    );

    expect(screen.getByRole('button')).toBeDisabled();
  });
});
