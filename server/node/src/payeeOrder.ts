import { CheckoutPaymentIntent } from "@paypal/paypal-server-sdk";

/**
 * Builds an Orders v2 request body whose funds go to `payeeEmail` (another
 * PayPal account) instead of this app's own account. Used by Snap & Pay
 * (pay a biller) and Split the Bill (pay back the host).
 */
export function buildPayeeOrderBody({
  payeeEmail,
  amount,
  currencyCode,
  description,
  itemName,
  customId,
}: {
  payeeEmail: string;
  /** a decimal string with 2 places, e.g. "42.50" */
  amount: string;
  currencyCode: string;
  description: string;
  itemName: string;
  customId?: string;
}) {
  return {
    intent: CheckoutPaymentIntent.Capture,
    purchaseUnits: [
      {
        payee: { emailAddress: payeeEmail },
        description: description.slice(0, 127),
        // customId (not invoiceId): PayPal rejects a repeated invoiceId,
        // which would block paying the same demo bill twice
        ...(customId && { customId: customId.slice(0, 127) }),
        amount: {
          currencyCode,
          value: amount,
          breakdown: {
            itemTotal: { currencyCode, value: amount },
          },
        },
        items: [
          {
            name: itemName.slice(0, 127),
            quantity: "1",
            unitAmount: { currencyCode, value: amount },
          },
        ],
      },
    ],
  };
}
