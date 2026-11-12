import { z, ZodError } from "zod/v4";
import { ApiError } from "@paypal/paypal-server-sdk";
import type { Request, Response, NextFunction } from "express";

import { CustomApiError } from "../customApiEndpoints/customApiError";

export default async function errorMiddleware(
  error: Error,
  _request: Request,
  response: Response,
  _next: NextFunction,
) {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: "Bad Request",
      errorDescription: z.prettifyError(error),
    });
  } else if (error instanceof ApiError || error instanceof CustomApiError) {
    const { result, statusCode } = error;
    response.status(statusCode).json(result);
  } else if (isBodyParserError(error)) {
    // e.g. 413 Payload Too Large or 400 for malformed JSON from express.json()
    response.status(error.status).json({
      error: error.type,
      errorDescription: error.message,
    });
  } else {
    response.status(500).json({
      error: "Internal Server Error",
      errorDescription: error.toString(),
    });
  }
}

function isBodyParserError(
  error: unknown,
): error is Error & { status: number; type: string } {
  const { status, type } = error as { status?: unknown; type?: unknown };
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    typeof type === "string"
  );
}
