// A refusal the caller should see as-is: bad input, path outside roots, limits.
export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}
