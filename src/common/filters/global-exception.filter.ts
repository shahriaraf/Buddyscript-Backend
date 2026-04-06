import {
  ExceptionFilter, Catch, ArgumentsHost, HttpException,
  HttpStatus, Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: unknown = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (typeof body === 'object' && body !== null) {
        const b = body as Record<string, unknown>;
        message = (b.message as string) ?? message;
        errors = Array.isArray(b.message) ? b.message : undefined;
        if (errors) message = 'Validation failed';
      }
    } else if (exception instanceof QueryFailedError) {
      // PostgreSQL unique violation
      if ((exception as any).code === '23505') {
        status = HttpStatus.CONFLICT;
        message = 'Resource already exists';
      } else {
        this.logger.error('DB query failed', (exception as Error).message);
      }
    } else {
      this.logger.error('Unhandled exception', exception);
    }

    res.status(status).json({
      statusCode: status,
      message,
      errors,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
