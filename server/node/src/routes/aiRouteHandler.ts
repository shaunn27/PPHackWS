import { z } from "zod/v4";
import type { Request, Response } from "express";

import { getBillExtractor } from "../ai";
import { getBillWarnings, getBillPaymentMaxAmount } from "../billPayment";
import { getReceiptWarnings } from "../split/receipt";

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
// 5 MB of image data is about 6.7 MB once base64-encoded
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const DATA_URL_PATTERN = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+=*)$/;

/** A base64 image data URL, checked for type and size. Shared by every AI route. */
export const ImageRequestSchema = z
  .object({
    image: z
      .string()
      .regex(DATA_URL_PATTERN, "image must be a base64 data URL"),
  })
  .transform(({ image }, context) => {
    const [, mimeType, base64] = DATA_URL_PATTERN.exec(image)!;

    if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType)) {
      context.addIssue({
        code: "custom",
        message: `Unsupported image type ${mimeType}. Use JPEG, PNG or WebP.`,
      });
      return z.NEVER;
    }

    const bytes = Math.floor((base64.length * 3) / 4);
    if (bytes > MAX_IMAGE_BYTES) {
      context.addIssue({
        code: "custom",
        message: "Image is larger than 5 MB.",
      });
      return z.NEVER;
    }

    return { mimeType, base64 };
  });

export async function extractBillRouteHandler(
  request: Request,
  response: Response,
) {
  const image = ImageRequestSchema.parse(request.body ?? {});
  const extractor = getBillExtractor();
  const bill = await extractor.extractBill(image);

  response.status(200).json({
    bill,
    warnings: getBillWarnings(bill),
    limits: { maxAmount: getBillPaymentMaxAmount() },
    provider: extractor.name,
  });
}

export async function extractReceiptRouteHandler(
  request: Request,
  response: Response,
) {
  const image = ImageRequestSchema.parse(request.body ?? {});
  const extractor = getBillExtractor();
  const receipt = await extractor.extractReceipt(image);

  response.status(200).json({
    receipt,
    warnings: getReceiptWarnings(receipt),
    provider: extractor.name,
  });
}
