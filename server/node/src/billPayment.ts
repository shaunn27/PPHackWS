import { z } from "zod/v4";

import type { ExtractedBill } from "./ai";

/*
 * Rules shared by the AI extraction route (to warn the user early) and the
 * bill-payment create-order route (to enforce them).
 */

// Currencies with 2 decimal places, so amounts can always be "123.45".
export const SUPPORTED_BILL_CURRENCIES = [
  "USD",
  "EUR",
  "GBP",
  "AUD",
  "CAD",
  "SGD",
] as const;

const DEFAULT_MAX_AMOUNT = 500;

export function getBillPaymentMaxAmount() {
  const value = Number(process.env.BILL_PAYMENT_MAX_AMOUNT);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_AMOUNT;
}

const AMOUNT_PATTERN = /^\d{1,7}(\.\d{1,2})?$/;

export const BillPaymentSchema = z
  .object({
    payeeEmail: z.email().max(254),
    amount: z
      .string()
      .trim()
      .regex(AMOUNT_PATTERN, "Amount must look like 123.45")
      .transform((value) => Number(value).toFixed(2))
      .refine((value) => Number(value) > 0, "Amount must be greater than 0")
      .refine((value) => Number(value) <= getBillPaymentMaxAmount(), {
        error: () =>
          `Amount exceeds the ${getBillPaymentMaxAmount()} limit for bill payments`,
      }),
    currencyCode: z.enum(SUPPORTED_BILL_CURRENCIES),
    billerName: z.string().trim().min(1).max(127),
    reference: z.string().trim().max(127).optional(),
  })
  .strict();

export type BillPayment = z.infer<typeof BillPaymentSchema>;

export type BillWarning = {
  code:
    | "NOT_A_BILL"
    | "MISSING_PAYEE"
    | "INVALID_PAYEE"
    | "MISSING_AMOUNT"
    | "INVALID_AMOUNT"
    | "OVER_LIMIT"
    | "UNSUPPORTED_CURRENCY"
    | "LOW_CONFIDENCE"
    | "MODEL_NOTE";
  message: string;
};

/** Deterministic checks on the model's output; never trust the model to police itself. */
export function getBillWarnings(bill: ExtractedBill): BillWarning[] {
  const warnings: BillWarning[] = [];
  const maxAmount = getBillPaymentMaxAmount();

  if (!bill.isBill) {
    warnings.push({
      code: "NOT_A_BILL",
      message: "This doesn't look like a bill or invoice.",
    });
  }

  if (!bill.payeeEmail) {
    warnings.push({
      code: "MISSING_PAYEE",
      message:
        "No PayPal payee email found on the bill. Enter it yourself, using a source you trust.",
    });
  } else if (!z.email().safeParse(bill.payeeEmail).success) {
    warnings.push({
      code: "INVALID_PAYEE",
      message: `"${bill.payeeEmail}" is not a valid email address.`,
    });
  }

  if (!bill.amount) {
    warnings.push({
      code: "MISSING_AMOUNT",
      message: "No amount due found on the bill.",
    });
  } else if (!AMOUNT_PATTERN.test(bill.amount)) {
    warnings.push({
      code: "INVALID_AMOUNT",
      message: `"${bill.amount}" is not a valid amount.`,
    });
  } else if (Number(bill.amount) > maxAmount) {
    warnings.push({
      code: "OVER_LIMIT",
      message: `The amount is over the ${maxAmount} limit for bill payments.`,
    });
  }

  if (
    bill.currencyCode &&
    !(SUPPORTED_BILL_CURRENCIES as readonly string[]).includes(
      bill.currencyCode,
    )
  ) {
    warnings.push({
      code: "UNSUPPORTED_CURRENCY",
      message: `${bill.currencyCode} isn't supported. Use one of: ${SUPPORTED_BILL_CURRENCIES.join(", ")}.`,
    });
  }

  if (bill.confidence === "low") {
    warnings.push({
      code: "LOW_CONFIDENCE",
      message: "The AI wasn't confident reading this bill. Check every field.",
    });
  }

  if (bill.notes) {
    warnings.push({ code: "MODEL_NOTE", message: bill.notes });
  }

  return warnings;
}
