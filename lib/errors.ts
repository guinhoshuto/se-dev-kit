export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'HttpError'; }
}
export class ConflictError extends HttpError {
  constructor() { super(409, 'This project changed elsewhere. Reload the latest revision before saving; your draft has not been replaced.'); }
}
