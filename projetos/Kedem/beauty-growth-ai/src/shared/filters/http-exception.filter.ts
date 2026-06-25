import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { ErrorResponse, FieldError } from '../interfaces';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let error = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let fieldErrors: FieldError[] | undefined;

    if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (typeof exceptionResponse === 'object') {
        const resp = exceptionResponse as Record<string, unknown>;
        message = (resp.message as string) || exception.message;
        error = (resp.error as string) || this.getErrorType(statusCode);

        // Handle class-validator errors
        if (Array.isArray(resp.message)) {
          fieldErrors = this.parseValidationErrors(resp.message as string[]);
          message = 'Validation failed';
          error = 'VALIDATION_ERROR';
        }
      }
    }

    if (!error || error === 'INTERNAL_ERROR') {
      error = this.getErrorType(statusCode);
    }

    const errorResponse: ErrorResponse = {
      statusCode,
      error,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
      traceId: (request.headers['x-trace-id'] as string) || uuidv4(),
      ...(fieldErrors && { fieldErrors }),
    };

    response.status(statusCode).json(errorResponse);
  }

  private getErrorType(statusCode: number): string {
    switch (statusCode) {
      case 400:
        return 'BAD_REQUEST';
      case 401:
        return 'UNAUTHORIZED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 409:
        return 'CONFLICT';
      case 422:
        return 'VALIDATION_ERROR';
      case 429:
        return 'TOO_MANY_REQUESTS';
      default:
        return 'INTERNAL_ERROR';
    }
  }

  private parseValidationErrors(messages: string[]): FieldError[] {
    return messages.map((msg) => {
      const parts = msg.split(' ');
      const field = parts[0] || 'unknown';
      return {
        field,
        message: msg,
        code: 'INVALID',
      };
    });
  }
}
