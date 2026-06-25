/**
 * Standard field-level error for validation failures.
 */
export interface FieldError {
  /** Name of the field that failed validation */
  field: string;
  /** Human-readable error message */
  message: string;
  /** Machine-readable error code (e.g., 'REQUIRED', 'MAX_LENGTH', 'INVALID_FORMAT') */
  code: string;
  /** Optional constraint metadata (e.g., { max: 120 } for MAX_LENGTH) */
  constraints?: Record<string, unknown>;
}

/**
 * Standard error response returned by all API endpoints.
 */
export interface ErrorResponse {
  /** HTTP status code */
  statusCode: number;
  /** Short error type identifier (e.g., 'VALIDATION_ERROR', 'NOT_FOUND', 'FORBIDDEN') */
  error: string;
  /** Human-readable error summary */
  message: string;
  /** Timestamp of the error occurrence */
  timestamp: string;
  /** Request path that generated the error */
  path: string;
  /** Correlation trace ID for observability */
  traceId?: string;
  /** Field-level validation errors (present for 400/422 responses) */
  fieldErrors?: FieldError[];
}
