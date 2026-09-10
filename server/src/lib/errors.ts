export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message?: string,
    /** Что клиенту нужно, чтобы показать внятный отказ: новая цена, альтернативы. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message ?? code)
  }
}

export const badRequest = (code: string, message?: string) => new ApiError(400, code, message)
export const notFound = (code: string, message?: string) => new ApiError(404, code, message)
export const conflict = (code: string, message?: string, details?: Record<string, unknown>) =>
  new ApiError(409, code, message, details)
