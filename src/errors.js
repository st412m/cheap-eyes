// A refusal the caller should see as-is: bad input, path outside roots, limits.
// `reason`: a short form for skip lists (glob matches that were not read).
export class InputError extends Error {
  constructor(message, { reason } = {}) {
    super(message);
    this.name = 'InputError';
    if (reason !== undefined) this.reason = reason;
  }
}
