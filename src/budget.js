// Daily budget with reservations. Before each model call its worst case is reserved;
// afterwards the reservation is settled to the real cost. Reservation is synchronous,
// so parallel chunks and async jobs in this process can never overshoot together.
// Separate processes do not share a ledger: the OpenRouter key limit is the real ceiling.
import { readUsage, spentOnDay, utcDay } from './usage.js';

export class BudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetError';
  }
}

export class Ledger {
  constructor(stateDir, { now = () => Date.now() } = {}) {
    this.stateDir = stateDir;
    this.now = now;
    this.day = null;
    this.loading = null;
    this.spent = 0;
    this.reserved = 0;
  }

  // Load today's spend from the usage log once per UTC day.
  async ensure() {
    const day = utcDay(this.now());
    if (this.day === day && this.loading) return this.loading;
    this.day = day;
    this.spent = 0;
    this.loading = readUsage(this.stateDir).then((records) => {
      this.spent += spentOnDay(records, day);
    });
    return this.loading;
  }

  // `budget`: USD or null (off). Returns a handle for settle().
  reserve(amount, budget) {
    // A non-finite or negative amount would poison the ledger (Infinity − Infinity = NaN).
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
      throw new BudgetError(`cannot reserve an unknown cost (${amount}); the model price is missing`);
    }
    if (budget !== null && budget !== undefined && this.spent + this.reserved + amount > budget + 1e-12) {
      throw new BudgetError(
        `daily budget exceeded: spent $${this.spent.toFixed(4)} + reserved $${this.reserved.toFixed(4)} + this call up to $${amount.toFixed(4)} > daily_budget_usd $${budget}`,
      );
    }
    this.reserved += amount;
    return { amount, day: this.day, settled: false };
  }

  settle(handle, actual) {
    if (handle.settled) return;
    handle.settled = true;
    // A cost we cannot read counts as the full reservation.
    const cost = typeof actual === 'number' && Number.isFinite(actual) && actual >= 0 ? actual : handle.amount;
    this.reserved = Math.max(0, this.reserved - handle.amount);
    if (handle.day === this.day) this.spent += cost;
  }
}

const ledgers = new Map();

// One ledger per state dir, at module level (shared by all server instances).
export function ledgerFor(stateDir) {
  let l = ledgers.get(stateDir);
  if (!l) {
    l = new Ledger(stateDir);
    ledgers.set(stateDir, l);
  }
  return l;
}

export function resetLedgers() {
  ledgers.clear();
}
