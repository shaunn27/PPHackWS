import { beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";

import { createOrderForBillPaymentRouteHandler } from "./ordersRouteHandler";
import errorMiddleware from "../middleware/errorMiddleware";

const { createOrderMock } = vi.hoisted(() => ({
  createOrderMock: vi.fn().mockResolvedValue({
    statusCode: 201,
    result: { id: "5O190127TN364715T", status: "CREATED" },
  }),
}));

vi.mock("@paypal/paypal-server-sdk", async () => {
  const actual = await vi.importActual("@paypal/paypal-server-sdk");
  return {
    ...actual,
    OrdersController: vi.fn(
      class {
        createOrder = createOrderMock;
      },
    ),
  };
});

const ROUTE = "/paypal-api/checkout/orders/create-order-for-bill-payment";

const validBill = {
  payeeEmail: "sb-biller@business.example.com",
  amount: "42.5",
  currencyCode: "USD",
  billerName: "Greenleaf Water Co.",
  reference: "GW-1001",
};

describe("createOrderForBillPaymentRouteHandler", () => {
  let app: Express;

  beforeEach(() => {
    // empty = use the default limit of 500
    vi.stubEnv("BILL_PAYMENT_MAX_AMOUNT", "");
    app = express();
    app.use(express.json());
    app.post(ROUTE, createOrderForBillPaymentRouteHandler);
    app.use(errorMiddleware);
  });

  test("creates an order that pays the biller's PayPal account", async () => {
    const response = await request(app).post(ROUTE).send(validBill);

    expect(response.status).toBe(201);
    expect(createOrderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: {
          intent: "CAPTURE",
          purchaseUnits: [
            {
              payee: { emailAddress: "sb-biller@business.example.com" },
              description: "Bill payment to Greenleaf Water Co.",
              customId: "GW-1001",
              amount: {
                currencyCode: "USD",
                value: "42.50",
                breakdown: {
                  itemTotal: { currencyCode: "USD", value: "42.50" },
                },
              },
              items: [
                {
                  name: "Greenleaf Water Co. - GW-1001",
                  quantity: "1",
                  unitAmount: { currencyCode: "USD", value: "42.50" },
                },
              ],
            },
          ],
        },
      }),
    );
  });

  test.each([
    ["an invalid payee email", { payeeEmail: "pay-me" }],
    ["an amount over the limit", { amount: "500.01" }],
    ["a zero amount", { amount: "0.00" }],
    ["a malformed amount", { amount: "$42.50" }],
    ["an unsupported currency", { currencyCode: "JPY" }],
    ["a missing biller name", { billerName: "" }],
    ["an unexpected field", { payeeMerchantId: "ABC123" }],
  ])("rejects %s", async (_label, override) => {
    const response = await request(app)
      .post(ROUTE)
      .send({ ...validBill, ...override });

    expect(response.status).toBe(400);
    expect(createOrderMock).not.toHaveBeenCalled();
  });

  test("respects BILL_PAYMENT_MAX_AMOUNT", async () => {
    vi.stubEnv("BILL_PAYMENT_MAX_AMOUNT", "1000");

    const response = await request(app)
      .post(ROUTE)
      .send({ ...validBill, amount: "750.00" });

    expect(response.status).toBe(201);
  });
});
