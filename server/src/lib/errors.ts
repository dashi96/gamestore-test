export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
  }
}

export const badRequest = (code: string, message?: string) => new ApiError(400, code, message)
export const notFound = (code: string, message?: string) => new ApiError(404, code, message)
export const conflict = (code: string, message?: string) => new ApiError(409, code, message)
