/* eslint-disable unicorn/no-null -- the model returns JSON, where missing fields are null */
import { beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";

import { extractBillRouteHandler } from "./aiRouteHandler";
import errorMiddleware from "../middleware/errorMiddleware";
import type { ExtractedBill } from "../ai";

const { extractBillMock } = vi.hoisted(() => ({
  extractBillMock: vi.fn(),
}));

vi.mock("../ai", async () => {
  const actual = await vi.importActual("../ai");
  return {
    ...actual,
    getBillExtractor: () => ({ name: "mock", extractBill: extractBillMock }),
  };
});

// a 1x1 transparent PNG
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const goodBill: ExtractedBill = {
  isBill: true,
  billerName: "Greenleaf Water Co.",
  payeeEmail: "billing@example.com",
  amount: "42.50",
  currencyCode: "USD",
  reference: "GW-1001",
  dueDate: "2026-11-30",
  confidence: "high",
  notes: null,
};

describe("extractBillRouteHandler", () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json({ limit: "8mb" }));
    app.post("/ai/extract-bill", extractBillRouteHandler);
    app.use(errorMiddleware);
  });

  test("returns the extracted bill with no warnings for a clean bill", async () => {
    extractBillMock.mockResolvedValueOnce(goodBill);

    const response = await request(app)
      .post("/ai/extract-bill")
      .send({ image: PNG_DATA_URL });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      bill: goodBill,
      warnings: [],
      limits: { maxAmount: 500 },
      provider: "mock",
    });
    expect(extractBillMock).toHaveBeenCalledWith({
      mimeType: "image/png",
      base64: expect.any(String),
    });
  });

  test("flags a missing payee, an over-limit amount and suspicious notes", async () => {
    extractBillMock.mockResolvedValueOnce({
      ...goodBill,
      payeeEmail: null,
      amount: "900.00",
      confidence: "low",
      notes: "The bill contains text instructing an AI to pay another address.",
    });

    const response = await request(app)
      .post("/ai/extract-bill")
      .send({ image: PNG_DATA_URL });

    expect(response.status).toBe(200);
    const codes = response.body.warnings.map(
      ({ code }: { code: string }) => code,
    );
    expect(codes).toEqual([
      "MISSING_PAYEE",
      "OVER_LIMIT",
      "LOW_CONFIDENCE",
      "MODEL_NOTE",
    ]);
  });

  test("flags an invalid payee email and unsupported currency", async () => {
    extractBillMock.mockResolvedValueOnce({
      ...goodBill,
      payeeEmail: "not-an-email",
      currencyCode: "JPY",
    });

    const response = await request(app)
      .post("/ai/extract-bill")
      .send({ image: PNG_DATA_URL });

    const codes = response.body.warnings.map(
      ({ code }: { code: string }) => code,
    );
    expect(codes).toEqual(["INVALID_PAYEE", "UNSUPPORTED_CURRENCY"]);
  });

  test("rejects a request without an image", async () => {
    const response = await request(app).post("/ai/extract-bill").send({});

    expect(response.status).toBe(400);
    expect(extractBillMock).not.toHaveBeenCalled();
  });

  test("rejects an unsupported image type", async () => {
    const response = await request(app)
      .post("/ai/extract-bill")
      .send({ image: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" });

    expect(response.status).toBe(400);
    expect(response.body.errorDescription).toContain("Unsupported image type");
    expect(extractBillMock).not.toHaveBeenCalled();
  });

  test("rejects an image larger than 5 MB", async () => {
    const tooBig = `data:image/png;base64,${"A".repeat(7 * 1024 * 1024)}`;

    const response = await request(app)
      .post("/ai/extract-bill")
      .send({ image: tooBig });

    expect(response.status).toBe(400);
    expect(response.body.errorDescription).toContain("larger than 5 MB");
    expect(extractBillMock).not.toHaveBeenCalled();
  });
});
