/** Matches NestJS HttpException JSON shape for client compatibility. */
export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string | string[],
    public readonly error: string,
  ) {
    super(Array.isArray(message) ? message.join(', ') : message);
    this.name = 'HttpError';
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string | string[]) {
    super(400, message, 'Bad Request');
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string | string[]) {
    super(404, message, 'Not Found');
  }
}
