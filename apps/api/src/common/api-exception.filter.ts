import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { maskSecrets } from "@qa-workbench/shared";
import type { Response } from "express";

export function clientErrorMessage(status: number, raw: string): string {
  if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) {
    return "You do not have permission to perform this action.";
  }
  if (status >= 500) return "Unexpected error";
  const cleaned = maskSecrets(raw)
    .replace(/password[=:]\s*\S+/gi, "password=***")
    .replace(/\s+at\s+.+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  if (!cleaned || /prisma|node_modules|secrets_encryption|postgres:\/\//i.test(cleaned)) {
    return "Unexpected error";
  }
  return cleaned;
}

/**
 * Known Prisma request errors are caused by the request (a missing record, a
 * duplicate, a dangling reference), not by the server, so they get a 4xx and
 * a message that says what to fix instead of a generic 500.
 */
export function prismaToHttp(
  exception: unknown,
): { status: number; message: string } | null {
  if (!(exception instanceof Prisma.PrismaClientKnownRequestError)) return null;
  switch (exception.code) {
    case "P2025":
      return { status: HttpStatus.NOT_FOUND, message: "The record no longer exists. Reload the page and try again." };
    case "P2002":
      return { status: HttpStatus.CONFLICT, message: "A record with the same unique value already exists." };
    case "P2003":
      return {
        status: HttpStatus.BAD_REQUEST,
        message: "A referenced record does not exist. Reload the page and try again.",
      };
    default:
      return null;
  }
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const known = prismaToHttp(exception);
    if (known) {
      this.logger.warn(`Prisma ${(exception as Prisma.PrismaClientKnownRequestError).code}: ${known.message}`);
      response.status(known.status).json({ statusCode: known.status, message: known.message });
      return;
    }
    const tooLarge =
      exception instanceof Error && /File too large|LIMIT_FILE_SIZE/i.test(exception.message);
    const status = tooLarge
      ? HttpStatus.BAD_REQUEST
      : exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const raw = tooLarge ? "File is too large" : readMessage(exception);
    if (!tooLarge && (!(exception instanceof HttpException) || status >= 500)) {
      this.logger.error(raw);
    }
    response.status(status).json({
      statusCode: status,
      message: clientErrorMessage(status, raw),
    });
  }
}

function readMessage(exception: unknown): string {
  if (exception instanceof HttpException) {
    const body = exception.getResponse();
    if (typeof body === "string") return body;
    if (body && typeof body === "object" && "message" in body) {
      const message = (body as { message?: unknown }).message;
      if (Array.isArray(message)) return message.map(String).join(" ");
      if (typeof message === "string") return message;
    }
    return exception.message;
  }
  if (exception instanceof Error) return exception.message;
  return "Unexpected error";
}
