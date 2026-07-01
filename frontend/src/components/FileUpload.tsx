import { useCallback, useRef, useState } from 'react';
import { Upload, X, Image } from 'lucide-react';
import { cn } from '@/lib/utils';

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'];
const ACCEPTED_EXTENSIONS = 'PNG, JPG, SVG';
const MAX_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

interface FileUploadProps {
  file: File | null;
  onChange: (file: File | null) => void;
  error?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function validateFile(file: File): string | null {
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return `Formato não suportado. Use apenas ${ACCEPTED_EXTENSIONS}.`;
  }
  if (file.size > MAX_SIZE_BYTES) {
    return `Arquivo muito grande (${formatFileSize(file.size)}). Tamanho máximo: 5MB.`;
  }
  return null;
}

export function FileUpload({ file, onChange, error }: FileUploadProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (selectedFile: File) => {
      const errorMsg = validateFile(selectedFile);
      if (errorMsg) {
        setValidationError(errorMsg);
        return;
      }

      setValidationError(null);

      // Gera URL de pré-visualização
      const url = URL.createObjectURL(selectedFile);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return url;
      });

      onChange(selectedFile);
    },
    [onChange]
  );

  const handleRemove = useCallback(() => {
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setValidationError(null);
    onChange(null);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  }, [onChange]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile) {
        handleFile(droppedFile);
      }
    },
    [handleFile]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const selectedFile = e.target.files?.[0];
      if (selectedFile) {
        handleFile(selectedFile);
      }
    },
    [handleFile]
  );

  const handleClick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        inputRef.current?.click();
      }
    },
    []
  );

  const displayError = error || validationError;

  return (
    <div className="w-full">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(',')}
        onChange={handleInputChange}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      />

      {file && previewUrl ? (
        /* Estado de pré-visualização */
        <div className="relative rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex items-center gap-4">
            <div className="relative h-16 w-16 flex-shrink-0 overflow-hidden rounded-md border border-border">
              {file.type === 'image/svg+xml' ? (
                <div className="flex h-full w-full items-center justify-center bg-muted">
                  <Image className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
                </div>
              ) : (
                <img
                  src={previewUrl}
                  alt="Pré-visualização do arquivo enviado"
                  className="h-full w-full object-cover"
                />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-foreground truncate">
                {file.name}
              </p>
              <p className="text-xs text-muted-foreground">
                {formatFileSize(file.size)}
              </p>
            </div>
            <button
              type="button"
              onClick={handleRemove}
              className="flex-shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
              aria-label="Remover arquivo"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : (
        /* Área de soltar arquivo */
        <div
          role="button"
          tabIndex={0}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          aria-label="Área de upload de arquivo. Arraste e solte ou clique para enviar"
          className={cn(
            'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 transition-colors',
            isDragOver
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/50',
            displayError && 'border-destructive/50'
          )}
        >
          <Upload
            className={cn(
              'mb-3 h-8 w-8',
              isDragOver ? 'text-primary' : 'text-muted-foreground'
            )}
            aria-hidden="true"
          />
          <p className="text-sm font-medium text-foreground">
            Arraste e solte ou clique para enviar
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Formatos aceitos: {ACCEPTED_EXTENSIONS} (máx. 5MB)
          </p>
        </div>
      )}

      {displayError && (
        <p className="mt-2 text-sm text-destructive" role="alert">
          {displayError}
        </p>
      )}
    </div>
  );
}
