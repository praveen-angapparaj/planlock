export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly code = 'BAD_REQUEST',
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export class PayPalApiError extends AppError {
  constructor(message: string, statusCode: number, code = 'PAYPAL_API_ERROR') {
    super(message, statusCode, code);
  }
}

export class AmbiguousPayPalError extends Error {
  constructor(message = 'The PayPal request outcome could not be confirmed.') {
    super(message);
  }
}
