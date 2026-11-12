// Repayment plan for a cover: 1-3 installments, due dates after the trip. Server-computed, integer cents.
import { addDays } from './dates.js';

export const MAX_INSTALLMENTS = 3;
const GAP_DAYS = 30; // first installment 30 days after the trip ends, then every 30 days

/** Equal installments (leftover cents to the earliest ones). */
export function repaymentPlan(amountCents, installments, tripEndDate) {
  if (!Number.isInteger(installments) || installments < 1 || installments > MAX_INSTALLMENTS) {
    throw new TypeError('installments must be 1-3');
  }
  const base = Math.floor(amountCents / installments);
  let leftover = amountCents - base * installments;
  return Array.from({ length: installments }, (_, i) => {
    const extra = leftover > 0 ? 1 : 0;
    leftover -= extra;
    return { n: i + 1, amountCents: base + extra, dueDate: addDays(tripEndDate, GAP_DAYS * (i + 1)) };
  });
}
