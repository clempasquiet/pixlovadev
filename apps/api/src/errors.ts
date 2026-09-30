import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Erreur métier sérialisée selon l’enveloppe API-006. */
export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

function body(request: FastifyRequest, error: ApiError): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      request_id: request.id,
      retryable: error.retryable,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

function normalize(error: FastifyError | ApiError): ApiError {
  if (error instanceof ApiError) return error;
  if ('validation' in error && error.validation) {
    return new ApiError(400, 'VALIDATION_ERROR', 'Requête invalide.');
  }
  const status = error.statusCode ?? 500;
  if (status === 413) return new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Requête trop volumineuse.');
  if (status === 415) return new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Format non supporté.');
  if (status === 429) return new ApiError(429, 'RATE_LIMITED', 'Trop de requêtes.', true);
  if (status >= 400 && status < 500)
    return new ApiError(400, 'VALIDATION_ERROR', 'Requête invalide.');
  // Aucun détail interne n’est renvoyé au client ; le log porte la corrélation.
  return new ApiError(500, 'INTERNAL_ERROR', 'Erreur interne.', true);
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | ApiError, request, reply: FastifyReply) => {
    const apiError = normalize(error);
    if (apiError.statusCode >= 500) request.log.error({ err: error }, 'request failed');
    return reply.status(apiError.statusCode).send(body(request, apiError));
  });
  app.setNotFoundHandler((request, reply) => {
    const error = new ApiError(404, 'RESOURCE_NOT_FOUND', 'Ressource introuvable.');
    return reply.status(404).send(body(request, error));
  });
}
