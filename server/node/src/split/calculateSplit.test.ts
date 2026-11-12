import { describe, expect, test } from "vitest";

import {
  allocateProportionally,
  calculateSplit,
  formatCents,
  reconcileReceipt,
  SplitError,
  toCents,
  type SplitInput,
  type SplitReceipt,
} from "./calculateSplit";

const host = { id: "host", name: "Alex", isHost: true };
const ben = { id: "ben", name: "Ben", isHost: false };
const cara = { id: "cara", name: "Cara", isHost: false };

const byName = (shares: ReturnType<typeof calculateSplit>) =>
  Object.fromEntries(shares.map((share) => [share.name, share.totalCents]));

const total = (shares: ReturnType<typeof calculateSplit>) =>
  shares.reduce((sum, share) => sum + share.totalCents, 0);

describe("toCents / formatCents", () => {
  test("convert between decimal strings and cents", () => {
    expect(toCents("42.5")).toBe(4250);
    expect(toCents("0.29")).toBe(29); // 0.29 * 100 = 28.999... in floating point
    expect(toCents("1.005")).toBe(101);
    expect(formatCents(4250)).toBe("42.50");
    expect(formatCents(7)).toBe("0.07");
    expect(formatCents(-305)).toBe("-3.05");
  });

  test("reject non-numbers", () => {
    expect(() => toCents("abc")).toThrow(SplitError);
  });
});

describe("allocateProportionally", () => {
  test("always sums to the amount", () => {
    expect(allocateProportionally(1000, [1, 1, 1])).toEqual([334, 333, 333]);
    expect(allocateProportionally(100, [2, 1])).toEqual([67, 33]);
    expect(allocateProportionally(0, [5, 5])).toEqual([0, 0]);
  });

  test("splits evenly when every weight is zero", () => {
    expect(allocateProportionally(10, [0, 0])).toEqual([5, 5]);
  });

  test("gives leftover cents to the largest remainder, then the first index", () => {
    // exact: 3.75, 6.25 -> floors 3, 6 -> leftover 1 to the 0.75 remainder
    expect(allocateProportionally(10, [3, 5])).toEqual([4, 6]);
  });
});

describe("calculateSplit: itemized", () => {
  test("splits tax in proportion to what each person ordered, not 50/50", () => {
    // the $50 steak / $10 salad example with 10% tax
    const receipt: SplitReceipt = {
      items: [
        { name: "Steak", lineTotalCents: 5000 },
        { name: "Salad", lineTotalCents: 1000 },
      ],
      charges: [{ label: "Tax 10%", amountCents: 600 }],
      discounts: [],
      totalCents: 6600,
    };

    const shares = calculateSplit({
      receipt,
      participants: [host, ben],
      mode: "itemized",
      assignments: { 0: ["host"], 1: ["ben"] },
    });

    expect(byName(shares)).toEqual({ Alex: 5500, Ben: 1100 });
    expect(shares[1].chargesCents).toBe(100); // not 300
  });

  test("divides a shared item among the people who had it", () => {
    const receipt: SplitReceipt = {
      items: [
        { name: "Dumplings to share", lineTotalCents: 1000 },
        { name: "Noodles", lineTotalCents: 1200 },
      ],
      charges: [],
      discounts: [],
      totalCents: 2200,
    };

    const shares = calculateSplit({
      receipt,
      participants: [ben, host, cara],
      mode: "itemized",
      assignments: { 0: ["ben", "cara", "host"], 1: ["cara"] },
    });

    // $10 / 3: the odd cent goes to the host
    expect(byName(shares)).toEqual({ Alex: 334, Ben: 333, Cara: 1533 });
    const caraItems = shares.find(({ name }) => name === "Cara")!.items;
    expect(caraItems).toEqual([
      { name: "Dumplings to share", shareCents: 333, sharedWith: 3 },
      { name: "Noodles", shareCents: 1200, sharedWith: 1 },
    ]);
  });

  test("applies charges and discounts proportionally and still adds up exactly", () => {
    const receipt: SplitReceipt = {
      items: [
        { name: "A", lineTotalCents: 1999 },
        { name: "B", lineTotalCents: 733 },
        { name: "C", lineTotalCents: 1250 },
      ],
      charges: [
        { label: "Service 10%", amountCents: 398 },
        { label: "Tax 6%", amountCents: 263 },
      ],
      discounts: [{ label: "Promo", amountCents: 500 }],
      totalCents: 1999 + 733 + 1250 + 398 + 263 - 500,
    };

    const shares = calculateSplit({
      receipt,
      participants: [host, ben, cara],
      mode: "itemized",
      assignments: { 0: ["host"], 1: ["ben", "cara"], 2: ["cara"] },
    });

    expect(total(shares)).toBe(receipt.totalCents);
    for (const share of shares) {
      expect(share.totalCents).toBe(
        share.itemsCents + share.chargesCents - share.discountsCents,
      );
    }
    expect(shares.reduce((sum, s) => sum + s.discountsCents, 0)).toBe(500);
  });

  test("a person with no items pays nothing", () => {
    const receipt: SplitReceipt = {
      items: [{ name: "Pizza", lineTotalCents: 2000 }],
      charges: [{ label: "Tip", amountCents: 300 }],
      discounts: [],
      totalCents: 2300,
    };

    const shares = calculateSplit({
      receipt,
      participants: [host, ben],
      mode: "itemized",
      assignments: { 0: ["host"] },
    });

    expect(byName(shares)).toEqual({ Alex: 2300, Ben: 0 });
  });

  test("rejects an item nobody claimed", () => {
    const input: SplitInput = {
      receipt: {
        items: [
          { name: "Tea", lineTotalCents: 300 },
          { name: "Cake", lineTotalCents: 500 },
        ],
        charges: [],
        discounts: [],
        totalCents: 800,
      },
      participants: [host, ben],
      mode: "itemized",
      assignments: { 0: ["ben"] },
    };

    expect(() => calculateSplit(input)).toThrow(`"Cake" isn't assigned`);
  });

  test("rejects an assignment to an unknown person", () => {
    expect(() =>
      calculateSplit({
        receipt: {
          items: [{ name: "Tea", lineTotalCents: 300 }],
          charges: [],
          discounts: [],
          totalCents: 300,
        },
        participants: [host, ben],
        mode: "itemized",
        assignments: { 0: ["mallory"] },
      }),
    ).toThrow("unknown person");
  });

  test("survives many random receipts without losing a cent", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const people = [host, ben, cara, { id: "dev", name: "Dev", isHost: false }];

    for (let run = 0; run < 300; run++) {
      const items = Array.from(
        { length: 1 + Math.floor(random() * 6) },
        (_, index) => ({
          name: `Item ${index}`,
          lineTotalCents: 1 + Math.floor(random() * 5000),
        }),
      );
      const itemsCents = items.reduce(
        (sum, item) => sum + item.lineTotalCents,
        0,
      );
      const charges = [
        { label: "Tax", amountCents: Math.floor(random() * 900) },
      ];
      const discounts = [
        {
          label: "Promo",
          amountCents: Math.floor(random() * Math.min(itemsCents, 500)),
        },
      ];
      const receipt: SplitReceipt = {
        items,
        charges,
        discounts,
        totalCents:
          itemsCents + charges[0].amountCents - discounts[0].amountCents,
      };
      const assignments = Object.fromEntries(
        items.map((_, index) => [
          index,
          [...people.filter(() => random() < 0.5).map(({ id }) => id), "host"],
        ]),
      );

      const shares = calculateSplit({
        receipt,
        participants: people,
        mode: "itemized",
        assignments,
      });
      expect(total(shares)).toBe(receipt.totalCents);
      for (const share of shares) {
        expect(share.totalCents).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("calculateSplit: equal", () => {
  test("divides the total evenly and gives the odd cent to the host", () => {
    const shares = calculateSplit({
      receipt: {
        items: [{ name: "Dinner", lineTotalCents: 1000 }],
        charges: [],
        discounts: [],
        totalCents: 1000,
      },
      participants: [ben, cara, host],
      mode: "equal",
    });

    expect(byName(shares)).toEqual({ Alex: 334, Ben: 333, Cara: 333 });
  });
});

describe("calculateSplit: validation", () => {
  const receipt: SplitReceipt = {
    items: [{ name: "Tea", lineTotalCents: 300 }],
    charges: [],
    discounts: [],
    totalCents: 300,
  };

  test("rejects a receipt that doesn't add up", () => {
    expect(() =>
      calculateSplit({
        receipt: { ...receipt, totalCents: 350 },
        participants: [host, ben],
        mode: "equal",
      }),
    ).toThrow("doesn't add up");
  });

  test("needs exactly one host and at least two people", () => {
    expect(() =>
      calculateSplit({ receipt, participants: [host], mode: "equal" }),
    ).toThrow("at least 2");
    expect(() =>
      calculateSplit({ receipt, participants: [ben, cara], mode: "equal" }),
    ).toThrow("exactly one host");
  });

  test("reconcileReceipt reports the difference", () => {
    expect(reconcileReceipt({ ...receipt, totalCents: 250 })).toMatchObject({
      computedTotalCents: 300,
      differenceCents: -50,
    });
  });
});
