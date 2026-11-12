import { z } from "zod/v4";

import type { ExtractedReceipt } from "../ai";
import { SUPPORTED_BILL_CURRENCIES } from "../billPayment";
import {
  formatCents,
  reconcileReceipt,
  toCents,
  type SplitReceipt,
} from "./calculateSplit";

const AMOUNT_PATTERN = /^\d{1,7}(\.\d{1,2})?$/;

const AmountSchema = z
  .string()
  .trim()
  .regex(AMOUNT_PATTERN, "Amounts must look like 12.50");

const LineSchema = z.object({
  label: z.string().trim().min(1).max(127),
  amount: AmountSchema,
});

/** The receipt as the host reviewed and corrected it in the form. */
export const ReviewedReceiptSchema = z
  .object({
    merchantName: z.string().trim().min(1).max(127),
    date: z.string().trim().max(32).optional(),
    currencyCode: z.enum(SUPPORTED_BILL_CURRENCIES),
    items: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(127),
          lineTotal: AmountSchema,
        }),
      )
      .min(1, "Add at least one item")
      .max(100),
    charges: z.array(LineSchema).max(20).default([]),
    discounts: z.array(LineSchema).max(20).default([]),
    total: AmountSchema,
  })
  .strict();

export type ReviewedReceipt = z.infer<typeof ReviewedReceiptSchema>;

export function toSplitReceipt(receipt: ReviewedReceipt): SplitReceipt {
  return {
    items: receipt.items.map(({ name, lineTotal }) => ({
      name,
      lineTotalCents: toCents(lineTotal),
    })),
    charges: receipt.charges.map(({ label, amount }) => ({
      label,
      amountCents: toCents(amount),
    })),
    discounts: receipt.discounts.map(({ label, amount }) => ({
      label,
      amountCents: toCents(amount),
    })),
    totalCents: toCents(receipt.total),
  };
}

export type ReceiptWarning = {
  code:
    | "NOT_A_RECEIPT"
    | "NO_ITEMS"
    | "INVALID_AMOUNT"
    | "SUBTOTAL_MISMATCH"
    | "TOTAL_MISMATCH"
    | "UNSUPPORTED_CURRENCY"
    | "LOW_CONFIDENCE"
    | "MODEL_NOTE";
  message: string;
};

/** Deterministic checks on the model's reading of a receipt. */
export function getReceiptWarnings(receipt: ExtractedReceipt) {
  const warnings: ReceiptWarning[] = [];

  if (!receipt.isReceipt) {
    warnings.push({
      code: "NOT_A_RECEIPT",
      message: "This doesn't look like a receipt.",
    });
  }
  if (receipt.items.length === 0) {
    warnings.push({
      code: "NO_ITEMS",
      message: "No line items found. Add them yourself, or split equally.",
    });
  }

  const amounts = [
    ...receipt.items.map(({ lineTotal }) => lineTotal),
    ...receipt.charges.map(({ amount }) => amount),
    ...receipt.discounts.map(({ amount }) => amount),
    receipt.total ?? "0",
  ];
  const badAmounts = amounts.filter((amount) => !AMOUNT_PATTERN.test(amount));
  if (badAmounts.length > 0) {
    warnings.push({
      code: "INVALID_AMOUNT",
      message: `Some amounts couldn't be read (${badAmounts.slice(0, 3).join(", ")}). Check them.`,
    });
  } else if (receipt.items.length > 0 && receipt.total) {
    const splitReceipt: SplitReceipt = {
      items: receipt.items.map(({ name, lineTotal }) => ({
        name,
        lineTotalCents: toCents(lineTotal),
      })),
      charges: receipt.charges.map(({ label, amount }) => ({
        label,
        amountCents: toCents(amount),
      })),
      discounts: receipt.discounts.map(({ label, amount }) => ({
        label,
        amountCents: toCents(amount),
      })),
      totalCents: toCents(receipt.total),
    };
    const { itemsCents, differenceCents, computedTotalCents } =
      reconcileReceipt(splitReceipt);

    if (
      receipt.subtotal &&
      AMOUNT_PATTERN.test(receipt.subtotal) &&
      toCents(receipt.subtotal) !== itemsCents
    ) {
      warnings.push({
        code: "SUBTOTAL_MISMATCH",
        message: `The items add up to ${formatCents(itemsCents)}, but the receipt's subtotal is ${receipt.subtotal}. An item may be missing or misread.`,
      });
    }
    if (differenceCents !== 0) {
      warnings.push({
        code: "TOTAL_MISMATCH",
        message: `Items, charges and discounts add up to ${formatCents(computedTotalCents)}, but the total is ${receipt.total}. Fix the lines before splitting.`,
      });
    }
  }

  if (
    receipt.currencyCode &&
    !(SUPPORTED_BILL_CURRENCIES as readonly string[]).includes(
      receipt.currencyCode,
    )
  ) {
    warnings.push({
      code: "UNSUPPORTED_CURRENCY",
      message: `${receipt.currencyCode} isn't supported. Use one of: ${SUPPORTED_BILL_CURRENCIES.join(", ")}.`,
    });
  }
  if (receipt.confidence === "low") {
    warnings.push({
      code: "LOW_CONFIDENCE",
      message:
        "The AI wasn't confident reading this receipt. Check every line.",
    });
  }
  if (receipt.notes) {
    warnings.push({ code: "MODEL_NOTE", message: receipt.notes });
  }
  return warnings;
}
