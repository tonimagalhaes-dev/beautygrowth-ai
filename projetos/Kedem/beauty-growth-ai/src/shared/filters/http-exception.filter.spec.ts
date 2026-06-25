import { HttpException, HttpStatus } from '@nestjs/common';
import { GlobalExceptionFilter } from './http-exception.filter';
import * as fc from 'fast-check';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let mockResponse: { status: jest.Mock; json: jest.Mock };
  let mockRequest: { url: string; headers: Record<string, string> };
  let mockHost: { switchToHttp: jest.Mock };

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockRequest = {
      url: '/test',
      headers: {},
    };
    mockHost = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    };
  });

  it('should format HttpException into ErrorResponse', () => {
    const exception = new HttpException('Not Found', HttpStatus.NOT_FOUND);

    filter.catch(exception, mockHost as never);

    expect(mockResponse.status).toHaveBeenCalledWith(404);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 404,
        error: 'NOT_FOUND',
        message: 'Not Found',
        path: '/test',
        timestamp: expect.any(String),
        traceId: expect.any(String),
      }),
    );
  });

  it('should handle unknown exceptions as 500', () => {
    const exception = new Error('Something broke');

    filter.catch(exception, mockHost as never);

    expect(mockResponse.status).toHaveBeenCalledWith(500);
    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 500,
        error: 'INTERNAL_ERROR',
      }),
    );
  });

  it('should use trace ID from request header if present', () => {
    mockRequest.headers['x-trace-id'] = 'custom-trace-123';
    const exception = new HttpException('Bad Request', HttpStatus.BAD_REQUEST);

    filter.catch(exception, mockHost as never);

    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'custom-trace-123',
      }),
    );
  });

  it('should include fieldErrors for validation exceptions with array messages', () => {
    const exception = new HttpException(
      {
        statusCode: 400,
        message: ['email must be a valid email', 'name should not be empty'],
        error: 'Bad Request',
      },
      HttpStatus.BAD_REQUEST,
    );

    filter.catch(exception, mockHost as never);

    expect(mockResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        error: 'VALIDATION_ERROR',
        message: 'Validation failed',
        fieldErrors: expect.arrayContaining([
          expect.objectContaining({ field: 'email', code: 'INVALID' }),
          expect.objectContaining({ field: 'name', code: 'INVALID' }),
        ]),
      }),
    );
  });

  describe('Property: ErrorResponse always contains required fields', () => {
    /**
     * Validates: Requirements 1.3, 2.4, 3.1 (error responses must include field-level errors)
     */
    it('should always produce an ErrorResponse with statusCode, error, message, timestamp, path, and traceId', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 400, max: 599 }),
          fc.string({ minLength: 1, maxLength: 100 }),
          (statusCode, msg) => {
            const exception = new HttpException(msg, statusCode);
            filter.catch(exception, mockHost as never);

            const response = mockResponse.json.mock.calls[mockResponse.json.mock.calls.length - 1][0];
            expect(response.statusCode).toBe(statusCode);
            expect(response.error).toBeDefined();
            expect(typeof response.error).toBe('string');
            expect(response.message).toBeDefined();
            expect(response.timestamp).toBeDefined();
            expect(response.path).toBe('/test');
            expect(response.traceId).toBeDefined();
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
