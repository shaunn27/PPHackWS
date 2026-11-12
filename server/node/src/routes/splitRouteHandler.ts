import { OrdersController } from "@paypal/paypal-server-sdk";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { Request, Response } from "express";

import { client } from "../paypalServerSdkClient";
import { CustomApiError } from "../customApiEndpoints/customApiError";
import { buildPayeeOrderBody } from "../payeeOrder";
import {
  calculateSplit,
  formatCents,
  SplitError,
  type ParticipantShare,
} from "../split/calculateSplit";
import { ReviewedReceiptSchema, toSplitReceipt } from "../split/receipt";
import {
  createSplit,
  findParticipantByToken,
  getSplit,
  newToken,
  updateParticipant,
  type StoredParticipant,
  type StoredSplit,
} from "../split/splitStore";

const ordersController = new OrdersController(client);

const PAGE_PATH = "/client/components/splitBill/html/src";

const ParticipantIdSchema = z
  .string()
  .regex(/^[\w-]{1,32}$/, "Invalid participant id");

const SplitRequestSchema = z
  .object({
    receipt: ReviewedReceiptSchema,
    host: z
      .object({
        id: ParticipantIdSchema,
        name: z.string().trim().min(1).max(60),
        email: z.email().max(254).optional(),
      })
      .strict(),
    friends: z
      .array(
        z
          .object({
            id: ParticipantIdSchema,
            name: z.string().trim().min(1).max(60),
          })
          .strict(),
      )
      .min(1, "Add at least one friend")
      .max(19),
    mode: z.enum(["itemized", "equal"]),
    // item index (as a string key) -> ids of the people who shared it
    assignments: z
      .record(z.string().regex(/^\d+$/), z.array(ParticipantIdSchema).max(20))
      .optional(),
  })
  .strict();

type SplitRequest = z.infer<typeof SplitRequestSchema>;

function badRequest(message: string) {
  return new CustomApiError({
    message,
    statusCode: 400,
    result: { error: "Bad Request", errorDescription: message },
  });
}

/** Always recompute shares on the server; never trust amounts from the browser. */
function computeShares(request: SplitRequest) {
  const participants = [
    { id: request.host.id, name: request.host.name, isHost: true },
    ...request.friends.map(({ id, name }) => ({ id, name, isHost: false })),
  ];
  try {
    return calculateSplit({
      receipt: toSplitReceipt(request.receipt),
      participants,
      mode: request.mode,
      assignments: request.assignments
        ? Object.fromEntries(
            Object.entries(request.assignments).map(([index, ids]) => [
              Number(index),
              ids,
            ]),
          )
        : undefined,
    });
  } catch (error) {
    if (error instanceof SplitError) {
      throw badRequest(error.message);
    }
    throw error;
  }
}

function formatShare(share: ParticipantShare) {
  return {
    participantId: share.participantId,
    name: share.name,
    isHost: share.isHost,
    items: share.items.map((item) => ({
      name: item.name,
      share: formatCents(item.shareCents),
      sharedWith: item.sharedWith,
    })),
    itemsTotal: formatCents(share.itemsCents),
    charges: formatCents(share.chargesCents),
    discounts: formatCents(share.discountsCents),
    total: formatCents(share.totalCents),
  };
}

const payPath = (split: StoredSplit, participant: StoredParticipant) =>
  `${PAGE_PATH}/pay.html?split=${split.id}&token=${participant.payToken}`;

function hostView(split: StoredSplit) {
  const owedCents = split.participants
    .filter((participant) => !participant.isHost)
    .reduce((sum, participant) => sum + participant.share.totalCents, 0);
  const collectedCents = split.participants
    .filter((participant) => participant.status === "paid")
    .reduce((sum, participant) => sum + participant.share.totalCents, 0);

  return {
    id: split.id,
    createdAt: split.createdAt,
    hostName: split.hostName,
    hostEmail: split.hostEmail,
    mode: split.mode,
    merchantName: split.receipt.merchantName,
    date: split.receipt.date,
    currencyCode: split.receipt.currencyCode,
    total: split.receipt.total,
    owed: formatCents(owedCents),
    collected: formatCents(collectedCents),
    hostPath: `${PAGE_PATH}/index.html?split=${split.id}&host=${split.hostToken}`,
    participants: split.participants.map((participant) => ({
      ...formatShare(participant.share),
      status: participant.status,
      paidAt: participant.paidAt,
      ...(!participant.isHost && { payPath: payPath(split, participant) }),
    })),
  };
}

function loadSplit(id: string) {
  const split = getSplit(id);
  if (!split) {
    throw new CustomApiError({
      message: "Split not found",
      statusCode: 404,
      result: {
        error: "Not Found",
        errorDescription: "This split doesn't exist",
      },
    });
  }
  return split;
}

function loadPayer(request: Request) {
  const { id, payToken } = z
    .object({ id: z.string(), payToken: z.string() })
    .parse(request.params);
  const split = loadSplit(id);
  const participant = findParticipantByToken(split, payToken);
  if (!participant) {
    throw new CustomApiError({
      message: "Pay link not found",
      statusCode: 404,
      result: {
        error: "Not Found",
        errorDescription: "This pay link isn't valid",
      },
    });
  }
  return { split, participant };
}

/* ######################################################################
 * Host routes
 * ###################################################################### */

export function previewSplitRouteHandler(request: Request, response: Response) {
  const splitRequest = SplitRequestSchema.parse(request.body ?? {});
  response.status(200).json({
    currencyCode: splitRequest.receipt.currencyCode,
    shares: computeShares(splitRequest).map((share) => formatShare(share)),
  });
}

export function createSplitRouteHandler(request: Request, response: Response) {
  const splitRequest = SplitRequestSchema.parse(request.body ?? {});
  if (!splitRequest.host.email) {
    throw badRequest("Enter the host's PayPal email, so friends can pay you");
  }
  const shares = computeShares(splitRequest);

  const split = createSplit({
    hostName: splitRequest.host.name,
    hostEmail: splitRequest.host.email,
    mode: splitRequest.mode,
    receipt: splitRequest.receipt,
    participants: shares.map((share) => ({
      id: share.participantId,
      name: share.name,
      isHost: share.isHost,
      payToken: newToken(),
      share,
      // the host already paid the restaurant, and nobody owes 0.00
      status: share.isHost || share.totalCents === 0 ? "host" : "pending",
    })),
  });

  response.status(201).json({ ...hostView(split), hostToken: split.hostToken });
}

export function getSplitRouteHandler(request: Request, response: Response) {
  const { id } = z.object({ id: z.string() }).parse(request.params);
  const { hostToken } = z
    .object({ hostToken: z.string() })
    .parse(request.query);
  const split = loadSplit(id);
  if (split.hostToken !== hostToken) {
    throw new CustomApiError({
      message: "Invalid host link",
      statusCode: 403,
      result: {
        error: "Forbidden",
        errorDescription: "This host link isn't valid",
      },
    });
  }
  response.status(200).json(hostView(split));
}

/* ######################################################################
 * Friend (payer) routes
 * ###################################################################### */

export function getPayViewRouteHandler(request: Request, response: Response) {
  const { split, participant } = loadPayer(request);
  response.status(200).json({
    merchantName: split.receipt.merchantName,
    date: split.receipt.date,
    currencyCode: split.receipt.currencyCode,
    receiptTotal: split.receipt.total,
    peopleCount: split.participants.length,
    hostName: split.hostName,
    status: participant.status,
    paidAt: participant.paidAt,
    share: formatShare(participant.share),
  });
}

function assertPayable(participant: StoredParticipant) {
  if (participant.status === "paid") {
    throw new CustomApiError({
      message: "Already paid",
      statusCode: 409,
      result: {
        error: "Conflict",
        errorDescription: "This share has already been paid",
      },
    });
  }
  if (participant.status === "host") {
    throw badRequest("There's nothing to pay for this share");
  }
}

export async function createSplitOrderRouteHandler(
  request: Request,
  response: Response,
) {
  const { split, participant } = loadPayer(request);
  assertPayable(participant);

  const { merchantName, currencyCode } = split.receipt;
  const body = buildPayeeOrderBody({
    payeeEmail: split.hostEmail,
    // the amount comes from the stored, server-computed share
    amount: formatCents(participant.share.totalCents),
    currencyCode,
    description: `${participant.name}'s share of ${merchantName}, paid back to ${split.hostName}`,
    itemName: `Your share of ${merchantName}`,
    customId: `${split.id}:${participant.id}`,
  });

  const { result, statusCode } = await ordersController.createOrder({
    body,
    paypalRequestId: randomUUID(),
    prefer: "return=minimal",
  });

  if (result.id) {
    updateParticipant(split.id, participant.id, { orderId: result.id });
  }
  response.status(statusCode).json(result);
}

export async function captureSplitOrderRouteHandler(
  request: Request,
  response: Response,
) {
  const { split, participant } = loadPayer(request);
  const { orderId } = z
    .object({ orderId: z.string().min(1) })
    .parse(request.body ?? {});

  if (participant.status === "paid" && participant.orderId === orderId) {
    // already reconciled (e.g. a retried request): report success again
    return response
      .status(200)
      .json({ status: "COMPLETED", alreadyPaid: true });
  }
  assertPayable(participant);
  if (participant.orderId !== orderId) {
    throw badRequest("This order doesn't belong to this pay link");
  }

  const { result, statusCode } = await ordersController.captureOrder({
    id: orderId,
    prefer: "return=representation",
    paypalRequestId: randomUUID(),
  });

  const capture = result.purchaseUnits?.[0]?.payments?.captures?.[0];
  const expected = formatCents(participant.share.totalCents);
  const completed =
    result.status === "COMPLETED" &&
    capture?.status === "COMPLETED" &&
    capture.amount?.value === expected &&
    capture.amount.currencyCode === split.receipt.currencyCode;

  if (!completed) {
    // e.g. PENDING, DECLINED, or a captured amount that doesn't match the
    // share: never mark it settled, and never tell the friend it worked
    console.warn(
      `Split ${split.id} share ${participant.id} not reconciled: order ${result.status}, capture ${capture?.status} ${capture?.amount?.value} ${capture?.amount?.currencyCode}, expected ${expected} ${split.receipt.currencyCode}`,
    );
    return response.status(502).json({
      status: "NOT_RECONCILED",
      error: "Payment not completed",
      errorDescription:
        capture?.status === "PENDING"
          ? "PayPal is still processing this payment. It will show as paid once it clears"
          : "The payment didn't complete as expected. You haven't been marked as paid",
    });
  }

  // auto-reconciliation: the share is settled the moment PayPal captures it
  updateParticipant(split.id, participant.id, {
    status: "paid",
    captureId: capture.id,
    paidAt: new Date().toISOString(),
  });

  response.status(statusCode).json({
    status: "COMPLETED",
    captureId: capture.id,
    amount: capture.amount,
  });
}
