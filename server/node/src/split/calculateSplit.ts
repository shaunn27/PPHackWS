/*
 * The split calculation engine. Pure functions, no I/O.
 *
 * All arithmetic is in integer cents, so there is no floating-point drift.
 * Rules:
 * - A shared item is divided equally among the people it is assigned to.
 * - Charges (tax, service, tip, delivery...) and discounts are divided in
 *   proportion to each person's share of the items, never 50/50.
 * - Every division uses the largest-remainder method, and any cent that
 *   still can't be divided fairly goes to the host, so the shares ALWAYS
 *   add up to the receipt total exactly.
 */

export type SplitMode = "itemized" | "equal";

export type ReceiptLine = { label: string; amountCents: number };

export type SplitReceipt = {
  items: { name: string; lineTotalCents: number }[];
  charges: ReceiptLine[];
  discounts: ReceiptLine[];
  totalCents: number;
};

export type SplitParticipant = { id: string; name: string; isHost: boolean };

export type SplitInput = {
  receipt: SplitReceipt;
  participants: SplitParticipant[];
  mode: SplitMode;
  /** itemized mode only: for each item index, who shared it */
  assignments?: Record<number, string[]>;
};

export type ParticipantShare = {
  participantId: string;
  name: string;
  isHost: boolean;
  items: { name: string; shareCents: number; sharedWith: number }[];
  itemsCents: number;
  chargesCents: number;
  discountsCents: number;
  totalCents: number;
};

export class SplitError extends Error {}

const DECIMAL_PATTERN = /^(-)?(\d{1,9})(?:\.(\d+))?$/;

/**
 * Parses a decimal amount like "42.5" into cents (4250) from its digits,
 * never through floating point (1.005 * 100 is 100.49999... in a float).
 * Fractions of a cent round half up.
 */
export function toCents(amount: string | number): number {
  const text = String(amount).trim();
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) {
    throw new SplitError(`"${amount}" is not a valid amount`);
  }
  const [, minus, whole, fraction = ""] = match;
  const padded = fraction.padEnd(3, "0");
  let cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) {
    cents += 1;
  }
  return minus ? -cents : cents;
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}

const sum = (values: number[]) =>
  values.reduce((total, value) => total + value, 0);

/**
 * Divides `amountCents` across `weights` proportionally, in whole cents,
 * using the largest-remainder method. Ties for the leftover cents go to the
 * lowest index first (callers put the host first). The result always sums
 * to `amountCents`.
 */
export function allocateProportionally(
  amountCents: number,
  weights: number[],
): number[] {
  if (weights.length === 0) {
    return [];
  }
  const totalWeight = sum(weights);
  // nothing to weigh by: split evenly instead
  const effectiveWeights = totalWeight > 0 ? weights : weights.map(() => 1);
  const effectiveTotal = sum(effectiveWeights);

  const exact = effectiveWeights.map(
    (weight) => (amountCents * weight) / effectiveTotal,
  );
  const shares = exact.map((value) => Math.floor(value));
  let leftover = amountCents - sum(shares);

  const order = exact.map((value, index) => ({
    index,
    remainder: value - Math.floor(value),
  }));
  order.sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  for (let position = 0; leftover > 0; position++, leftover--) {
    shares[order[position % order.length].index] += 1;
  }
  return shares;
}

/** Checks that items + charges - discounts = total, to the cent. */
export function reconcileReceipt(receipt: SplitReceipt) {
  const itemsCents = sum(receipt.items.map((item) => item.lineTotalCents));
  const chargesCents = sum(receipt.charges.map((line) => line.amountCents));
  const discountsCents = sum(receipt.discounts.map((line) => line.amountCents));
  const computedTotalCents = itemsCents + chargesCents - discountsCents;
  return {
    itemsCents,
    chargesCents,
    discountsCents,
    computedTotalCents,
    differenceCents: receipt.totalCents - computedTotalCents,
  };
}

export function calculateSplit(input: SplitInput): ParticipantShare[] {
  const { receipt, mode } = input;

  if (input.participants.length < 2) {
    throw new SplitError("A split needs at least 2 people");
  }
  const hosts = input.participants.filter((person) => person.isHost);
  if (hosts.length !== 1) {
    throw new SplitError("A split needs exactly one host");
  }
  if (
    new Set(input.participants.map(({ id }) => id)).size !==
    input.participants.length
  ) {
    throw new SplitError("Participant ids must be unique");
  }
  if (receipt.totalCents <= 0) {
    throw new SplitError("The receipt total must be greater than 0");
  }
  for (const line of [
    ...receipt.items.map((item) => item.lineTotalCents),
    ...receipt.charges.map((charge) => charge.amountCents),
    ...receipt.discounts.map((discount) => discount.amountCents),
  ]) {
    if (!Number.isInteger(line) || line < 0) {
      throw new SplitError("Amounts must be whole, non-negative cents");
    }
  }

  const reconciliation = reconcileReceipt(receipt);
  if (reconciliation.differenceCents !== 0) {
    throw new SplitError(
      `The receipt doesn't add up: items + charges - discounts = ${formatCents(reconciliation.computedTotalCents)}, but the total is ${formatCents(receipt.totalCents)}. Fix the receipt first.`,
    );
  }

  // host first, so every "leftover cent" tie goes to the host
  const people = [
    ...hosts,
    ...input.participants.filter((person) => !person.isHost),
  ];
  const indexOf = new Map(people.map((person, index) => [person.id, index]));

  const shares: ParticipantShare[] = people.map((person) => ({
    participantId: person.id,
    name: person.name,
    isHost: person.isHost,
    items: [],
    itemsCents: 0,
    chargesCents: 0,
    discountsCents: 0,
    totalCents: 0,
  }));

  if (mode === "equal") {
    const totals = allocateProportionally(
      receipt.totalCents,
      people.map(() => 1),
    );
    for (const [index, share] of shares.entries()) {
      share.totalCents = totals[index];
    }
    return shares;
  }

  // itemized: every item must be claimed by at least one known person
  const assignments = input.assignments ?? {};
  for (const [itemIndex, item] of receipt.items.entries()) {
    const owners = [...new Set(assignments[itemIndex])];
    if (owners.length === 0) {
      throw new SplitError(`"${item.name}" isn't assigned to anyone`);
    }
    const ownerIndexes = owners.map((id) => {
      const index = indexOf.get(id);
      if (index === undefined) {
        throw new SplitError(`"${item.name}" is assigned to an unknown person`);
      }
      return index;
    });

    // sort so the host (index 0) is first in line for an odd cent
    ownerIndexes.sort((a, b) => a - b);
    const pieces = allocateProportionally(
      item.lineTotalCents,
      ownerIndexes.map(() => 1),
    );
    for (const [position, personIndex] of ownerIndexes.entries()) {
      shares[personIndex].items.push({
        name: item.name,
        shareCents: pieces[position],
        sharedWith: ownerIndexes.length,
      });
      shares[personIndex].itemsCents += pieces[position];
    }
  }

  const weights = shares.map((share) => share.itemsCents);
  const charges = allocateProportionally(reconciliation.chargesCents, weights);
  const discounts = allocateProportionally(
    reconciliation.discountsCents,
    weights,
  );

  for (const [index, share] of shares.entries()) {
    share.chargesCents = charges[index];
    share.discountsCents = discounts[index];
    share.totalCents =
      share.itemsCents + share.chargesCents - share.discountsCents;
  }

  return shares;
}
