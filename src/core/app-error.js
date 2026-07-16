export class AppError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function assertCondition(condition, code, message, status = 400, details = undefined) {
  if (!condition) {
    throw new AppError(code, message, status, details);
  }
}
