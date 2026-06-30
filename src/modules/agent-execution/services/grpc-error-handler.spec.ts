import { Test, TestingModule } from '@nestjs/testing';
import * as grpc from '@grpc/grpc-js';

import { GrpcErrorHandler, GrpcClientError } from './grpc-error-handler';

describe('GrpcErrorHandler', () => {
  let handler: GrpcErrorHandler;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GrpcErrorHandler],
    }).compile();

    handler = module.get<GrpcErrorHandler>(GrpcErrorHandler);
  });

  describe('handleError', () => {
    const traceId = 'trace-abc-123';

    it('should be defined', () => {
      expect(handler).toBeDefined();
    });

    // -----------------------------------------------------------------
    // UNAVAILABLE error (gRPC code 14)
    // -----------------------------------------------------------------
    describe('UNAVAILABLE errors', () => {
      it('should identify UNAVAILABLE error correctly', () => {
        const rawError = {
          code: grpc.status.UNAVAILABLE,
          details: 'Connection refused',
          message: 'Connection refused',
        };

        const result = handler.handleError(rawError, traceId);

        expect(result).toBeInstanceOf(GrpcClientError);
        expect(result.code).toBe(grpc.status.UNAVAILABLE);
        expect(result.traceId).toBe(traceId);
        expect(result.message).toContain('not reachable');
        expect(result.isRetryable).toBe(true);
      });

      it('should set isRetryable to true for UNAVAILABLE', () => {
        const rawError = {
          code: grpc.status.UNAVAILABLE,
          details: 'Service unavailable',
        };

        const result = handler.handleError(rawError, traceId);

        expect(result.isRetryable).toBe(true);
      });
    });

    // -----------------------------------------------------------------
    // DEADLINE_EXCEEDED error (gRPC code 4)
    // -----------------------------------------------------------------
    describe('DEADLINE_EXCEEDED errors', () => {
      it('should identify DEADLINE_EXCEEDED as timeout error', () => {
        const rawError = {
          code: grpc.status.DEADLINE_EXCEEDED,
          details: 'Deadline exceeded',
          message: 'Deadline exceeded',
        };

        const result = handler.handleError(rawError, traceId);

        expect(result).toBeInstanceOf(GrpcClientError);
        expect(result.code).toBe(grpc.status.DEADLINE_EXCEEDED);
        expect(result.traceId).toBe(traceId);
        expect(result.message).toContain('timed out');
        expect(result.isRetryable).toBe(true);
      });

      it('should set isRetryable to true for DEADLINE_EXCEEDED', () => {
        const rawError = {
          code: grpc.status.DEADLINE_EXCEEDED,
          details: 'Timeout',
        };

        const result = handler.handleError(rawError, traceId);

        expect(result.isRetryable).toBe(true);
      });
    });

    // -----------------------------------------------------------------
    // Deserialization errors
    // -----------------------------------------------------------------
    describe('deserialization errors', () => {
      it('should identify deserialization error from message', () => {
        const rawError = {
          code: grpc.status.INTERNAL,
          details: 'Failed to deserialize response',
          message: 'Failed to deserialize response',
        };

        const result = handler.handleError(rawError, traceId);

        expect(result).toBeInstanceOf(GrpcClientError);
        expect(result.message).toContain('deserialize');
        expect(result.isRetryable).toBe(false);
      });

      it('should detect "failed to parse" as deserialization error', () => {
        const rawError = {
          code: grpc.status.INTERNAL,
          details: 'Failed to parse protobuf message',
        };

        const result = handler.handleError(rawError, traceId);

        expect(result.message).toContain('deserialize');
        expect(result.isRetryable).toBe(false);
      });

      it('should detect "invalid wire type" as deserialization error', () => {
        const rawError = {
          code: grpc.status.INTERNAL,
          details: 'invalid wire type at offset 23',
        };

        const result = handler.handleError(rawError, traceId);

        expect(result.message).toContain('deserialize');
        expect(result.isRetryable).toBe(false);
      });
    });

    // -----------------------------------------------------------------
    // Unknown / INTERNAL errors
    // -----------------------------------------------------------------
    describe('unknown/INTERNAL errors', () => {
      it('should wrap unknown errors with INTERNAL code', () => {
        const rawError = {
          code: grpc.status.INTERNAL,
          details: 'Something went wrong',
        };

        const result = handler.handleError(rawError, traceId);

        expect(result).toBeInstanceOf(GrpcClientError);
        expect(result.code).toBe(grpc.status.INTERNAL);
        expect(result.message).toContain('internal error');
        expect(result.isRetryable).toBe(false);
      });

      it('should handle errors without a code', () => {
        const rawError = {
          message: 'Network error',
        };

        const result = handler.handleError(rawError, traceId);

        expect(result).toBeInstanceOf(GrpcClientError);
        expect(result.code).toBe(grpc.status.INTERNAL);
        expect(result.isRetryable).toBe(false);
      });

      it('should handle completely empty error', () => {
        const result = handler.handleError({}, traceId);

        expect(result).toBeInstanceOf(GrpcClientError);
        expect(result.code).toBe(grpc.status.INTERNAL);
        expect(result.traceId).toBe(traceId);
      });
    });

    // -----------------------------------------------------------------
    // traceId preservation
    // -----------------------------------------------------------------
    describe('traceId preservation', () => {
      it('should preserve traceId in the error', () => {
        const customTraceId = 'trace-unique-xyz-789';
        const rawError = {
          code: grpc.status.UNAVAILABLE,
          details: 'Service down',
        };

        const result = handler.handleError(rawError, customTraceId);

        expect(result.traceId).toBe(customTraceId);
      });

      it('should preserve traceId for timeout errors', () => {
        const customTraceId = 'trace-timeout-001';
        const rawError = {
          code: grpc.status.DEADLINE_EXCEEDED,
          details: 'Timeout',
        };

        const result = handler.handleError(rawError, customTraceId);

        expect(result.traceId).toBe(customTraceId);
      });

      it('should preserve traceId for internal errors', () => {
        const customTraceId = 'trace-internal-002';
        const rawError = {
          code: grpc.status.PERMISSION_DENIED,
          details: 'Permission denied',
        };

        const result = handler.handleError(rawError, customTraceId);

        expect(result.traceId).toBe(customTraceId);
      });
    });

    // -----------------------------------------------------------------
    // isRetryable flag correctness
    // -----------------------------------------------------------------
    describe('isRetryable flag', () => {
      it('should mark UNAVAILABLE as retryable', () => {
        const error = handler.handleError(
          { code: grpc.status.UNAVAILABLE, details: 'down' },
          traceId,
        );
        expect(error.isRetryable).toBe(true);
      });

      it('should mark DEADLINE_EXCEEDED as retryable', () => {
        const error = handler.handleError(
          { code: grpc.status.DEADLINE_EXCEEDED, details: 'timeout' },
          traceId,
        );
        expect(error.isRetryable).toBe(true);
      });

      it('should mark PERMISSION_DENIED as not retryable', () => {
        const error = handler.handleError(
          { code: grpc.status.PERMISSION_DENIED, details: 'denied' },
          traceId,
        );
        expect(error.isRetryable).toBe(false);
      });

      it('should mark INVALID_ARGUMENT as not retryable', () => {
        const error = handler.handleError(
          { code: grpc.status.INVALID_ARGUMENT, details: 'bad input' },
          traceId,
        );
        expect(error.isRetryable).toBe(false);
      });

      it('should mark NOT_FOUND as not retryable', () => {
        const error = handler.handleError(
          { code: grpc.status.NOT_FOUND, details: 'not found' },
          traceId,
        );
        expect(error.isRetryable).toBe(false);
      });
    });
  });

  // ===================================================================
  // isTimeoutError
  // ===================================================================
  describe('isTimeoutError', () => {
    it('should return true for DEADLINE_EXCEEDED raw error', () => {
      const rawError = { code: grpc.status.DEADLINE_EXCEEDED };
      expect(handler.isTimeoutError(rawError)).toBe(true);
    });

    it('should return true for GrpcClientError with DEADLINE_EXCEEDED', () => {
      const error = new GrpcClientError({
        code: grpc.status.DEADLINE_EXCEEDED,
        message: 'timeout',
        traceId: 'trace-1',
        isRetryable: true,
      });
      expect(handler.isTimeoutError(error)).toBe(true);
    });

    it('should return false for UNAVAILABLE error', () => {
      const rawError = { code: grpc.status.UNAVAILABLE };
      expect(handler.isTimeoutError(rawError)).toBe(false);
    });

    it('should return false for INTERNAL error', () => {
      const rawError = { code: grpc.status.INTERNAL };
      expect(handler.isTimeoutError(rawError)).toBe(false);
    });
  });

  // ===================================================================
  // isUnavailableError
  // ===================================================================
  describe('isUnavailableError', () => {
    it('should return true for UNAVAILABLE raw error', () => {
      const rawError = { code: grpc.status.UNAVAILABLE };
      expect(handler.isUnavailableError(rawError)).toBe(true);
    });

    it('should return true for GrpcClientError with UNAVAILABLE', () => {
      const error = new GrpcClientError({
        code: grpc.status.UNAVAILABLE,
        message: 'service down',
        traceId: 'trace-2',
        isRetryable: true,
      });
      expect(handler.isUnavailableError(error)).toBe(true);
    });

    it('should return false for DEADLINE_EXCEEDED error', () => {
      const rawError = { code: grpc.status.DEADLINE_EXCEEDED };
      expect(handler.isUnavailableError(rawError)).toBe(false);
    });

    it('should return false for INTERNAL error', () => {
      const rawError = { code: grpc.status.INTERNAL };
      expect(handler.isUnavailableError(rawError)).toBe(false);
    });
  });

  // ===================================================================
  // GrpcClientError class
  // ===================================================================
  describe('GrpcClientError', () => {
    it('should extend Error', () => {
      const error = new GrpcClientError({
        code: grpc.status.UNAVAILABLE,
        message: 'test error',
        traceId: 'trace-1',
        isRetryable: true,
      });

      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('GrpcClientError');
    });

    it('should have a proper stack trace', () => {
      const error = new GrpcClientError({
        code: grpc.status.INTERNAL,
        message: 'stack test',
        traceId: 'trace-stack',
        isRetryable: false,
      });

      expect(error.stack).toBeDefined();
    });
  });
});
