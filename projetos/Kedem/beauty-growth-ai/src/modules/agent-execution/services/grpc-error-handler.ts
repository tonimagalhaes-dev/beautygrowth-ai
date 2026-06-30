import { Injectable, Logger } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';

/**
 * Typed gRPC client error that extends Error with structured metadata.
 * Contains the gRPC status code, trace ID for correlation, and
 * a flag indicating whether the error is retryable.
 *
 * Requirements: 1.6
 */
export class GrpcClientError extends Error {
  /** gRPC status code (e.g., 14 for UNAVAILABLE, 4 for DEADLINE_EXCEEDED) */
  readonly code: number;

  /** Trace ID from the original call for correlation */
  readonly traceId: string;

  /** Whether this error is retryable (UNAVAILABLE and DEADLINE_EXCEEDED are retryable) */
  readonly isRetryable: boolean;

  constructor(params: {
    code: number;
    message: string;
    traceId: string;
    isRetryable: boolean;
  }) {
    super(params.message);
    this.name = 'GrpcClientError';
    this.code = params.code;
    this.traceId = params.traceId;
    this.isRetryable = params.isRetryable;
  }
}

/**
 * Error categories handled by the GrpcErrorHandler.
 */
export enum GrpcErrorCategory {
  UNAVAILABLE = 'UNAVAILABLE',
  DEADLINE_EXCEEDED = 'DEADLINE_EXCEEDED',
  DESERIALIZATION_ERROR = 'DESERIALIZATION_ERROR',
  INTERNAL = 'INTERNAL',
}

/**
 * GrpcErrorHandler categorizes and wraps raw gRPC errors into typed GrpcClientError instances.
 *
 * Error categories:
 * - UNAVAILABLE (gRPC code 14): service not reachable — retryable
 * - DEADLINE_EXCEEDED (gRPC code 4): timeout — retryable
 * - DESERIALIZATION_ERROR: failed to parse response — not retryable
 * - INTERNAL: all other errors — not retryable
 *
 * Requirements: 1.6, 1.7
 */
@Injectable()
export class GrpcErrorHandler {
  private readonly logger = new Logger(GrpcErrorHandler.name);

  /**
   * Categorizes and wraps a raw gRPC error into a typed GrpcClientError.
   *
   * @param error - The raw error from a gRPC call
   * @param traceId - The trace ID of the original call for correlation
   * @returns A typed GrpcClientError with code, message, traceId, and isRetryable
   */
  handleError(error: any, traceId: string): GrpcClientError {
    const code = this.extractCode(error);
    const category = this.categorize(code, error);
    const message = this.buildMessage(error, category);
    const isRetryable = this.isRetryableCategory(category);

    const grpcError = new GrpcClientError({
      code,
      message,
      traceId,
      isRetryable,
    });

    this.logger.warn(
      `gRPC error [${category}] code=${code} trace=${traceId}: ${message}`,
    );

    return grpcError;
  }

  /**
   * Checks if an error is a timeout (DEADLINE_EXCEEDED) error.
   *
   * @param error - The raw error to check
   * @returns true if the error represents a deadline/timeout
   */
  isTimeoutError(error: any): boolean {
    if (error instanceof GrpcClientError) {
      return error.code === grpc.status.DEADLINE_EXCEEDED;
    }
    const code = this.extractCode(error);
    return code === grpc.status.DEADLINE_EXCEEDED;
  }

  /**
   * Checks if an error indicates the service is unavailable/down.
   *
   * @param error - The raw error to check
   * @returns true if the error represents a service unavailable condition
   */
  isUnavailableError(error: any): boolean {
    if (error instanceof GrpcClientError) {
      return error.code === grpc.status.UNAVAILABLE;
    }
    const code = this.extractCode(error);
    return code === grpc.status.UNAVAILABLE;
  }

  /**
   * Extracts the gRPC status code from an error object.
   */
  private extractCode(error: any): number {
    if (typeof error?.code === 'number') {
      return error.code;
    }
    return grpc.status.INTERNAL;
  }

  /**
   * Categorizes the error based on its gRPC code and characteristics.
   */
  private categorize(code: number, error: any): GrpcErrorCategory {
    if (code === grpc.status.UNAVAILABLE) {
      return GrpcErrorCategory.UNAVAILABLE;
    }

    if (code === grpc.status.DEADLINE_EXCEEDED) {
      return GrpcErrorCategory.DEADLINE_EXCEEDED;
    }

    // Detect deserialization errors — typically manifest as INTERNAL errors
    // with messages about parsing/decoding/deserialization
    if (this.isDeserializationError(error)) {
      return GrpcErrorCategory.DESERIALIZATION_ERROR;
    }

    return GrpcErrorCategory.INTERNAL;
  }

  /**
   * Determines if an error is a deserialization/parsing error.
   */
  private isDeserializationError(error: any): boolean {
    const message = (
      error?.details ||
      error?.message ||
      ''
    ).toLowerCase();

    return (
      message.includes('deserializ') ||
      message.includes('failed to parse') ||
      message.includes('decode') ||
      message.includes('invalid wire type') ||
      message.includes('malformed')
    );
  }

  /**
   * Builds a human-readable error message based on the category.
   */
  private buildMessage(error: any, category: GrpcErrorCategory): string {
    const rawMessage = error?.details || error?.message || 'Unknown error';

    switch (category) {
      case GrpcErrorCategory.UNAVAILABLE:
        return `LangGraph service is not reachable: ${rawMessage}`;
      case GrpcErrorCategory.DEADLINE_EXCEEDED:
        return `gRPC call timed out: ${rawMessage}`;
      case GrpcErrorCategory.DESERIALIZATION_ERROR:
        return `Failed to deserialize gRPC response: ${rawMessage}`;
      case GrpcErrorCategory.INTERNAL:
        return `gRPC internal error: ${rawMessage}`;
    }
  }

  /**
   * Determines if an error category is retryable.
   * UNAVAILABLE and DEADLINE_EXCEEDED are retryable.
   */
  private isRetryableCategory(category: GrpcErrorCategory): boolean {
    return (
      category === GrpcErrorCategory.UNAVAILABLE ||
      category === GrpcErrorCategory.DEADLINE_EXCEEDED
    );
  }
}
