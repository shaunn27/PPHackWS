import { beforeEach, describe, expect, test, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";

import {
  captureSplitOrderRouteHandler,
  createSplitOrderRouteHandler,
  createSplitRouteHandler,
  getPayViewRouteHandler,
  getSplitRouteHandler,
  previewSplitRouteHandler,
} from "./splitRouteHandler";
import errorMiddleware from "../middleware/errorMiddleware";
import { clearSplits } from "../split/splitStore";

const { createOrderMock, captureOrderMock } = vi.hoisted(() => ({
  createOrderMock: vi.fn(),
  captureOrderMock: vi.fn(),
}));

vi.mock("@paypal/paypal-server-sdk", async () => {
  const actual = await vi.importActual("@paypal/paypal-server-sdk");
  return {
    ...actual,
    OrdersController: vi.fn(
      class {
        createOrder = createOrderMock;
        captureOrder = captureOrderMock;
      },
    ),
  };
});

function completedCapture(value: string, currencyCode = "USD") {
  return {
    statusCode: 201,
    result: {
      id: "ORDER-1",
      status: "COMPLETED",
      purchaseUnits: [
        {
          payments: {
            captures: [
              {
                id: "CAPTURE-1",
                status: "COMPLETED",
                amount: { value, currencyCode },
              },
            ],
          },
        },
      ],
    },
  };
}

// steak / salad / shared dumplings with tax and service
const splitRequest = {
  receipt: {
    merchantName: "Lantern Noodle House",
    date: "2026-11-12",
    currencyCode: "USD",
    items: [
      { name: "Steak", lineTotal: "50.00" },
      { name: "Salad", lineTotal: "10.00" },
      { name: "Dumplings", lineTotal: "9.00" },
    ],
    charges: [
      { label: "Service 10%", amount: "6.90" },
      { label: "Tax 6%", amount: "4.14" },
    ],
    discounts: [{ label: "Promo", amount: "5.00" }],
    total: "75.04",
  },
  host: { id: "p0", name: "Alex", email: "sb-host@personal.example.com" },
  friends: [
    { id: "p1", name: "Ben" },
    { id: "p2", name: "Cara" },
  ],
  mode: "itemized",
  assignments: { "0": ["p0"], "1": ["p1"], "2": ["p0", "p1", "p2"] },
};

describe("split routes", () => {
  let app: Express;

  beforeEach(() => {
    clearSplits();
    createOrderMock.mockResolvedValue({
      statusCode: 201,
      result: { id: "ORDER-1", status: "CREATED" },
    });
    app = express();
    app.use(express.json());
    app.post("/api/splits/preview", previewSplitRouteHandler);
    app.post("/api/splits", createSplitRouteHandler);
    app.get("/api/splits/:id", getSplitRouteHandler);
    app.get("/api/splits/:id/pay/:payToken", getPayViewRouteHandler);
    app.post(
      "/api/splits/:id/pay/:payToken/create-order",
      createSplitOrderRouteHandler,
    );
    app.post(
      "/api/splits/:id/pay/:payToken/capture",
      captureSplitOrderRouteHandler,
    );
    app.use(errorMiddleware);
  });

  async function createTestSplit() {
    const response = await request(app).post("/api/splits").send(splitRequest);
    expect(response.status).toBe(201);
    const ben = response.body.participants.find(
      ({ name }: { name: string }) => name === "Ben",
    );
    const payToken = new URL(ben.payPath, "http://x").searchParams.get("token");
    return { split: response.body, ben, payToken };
  }

  test("preview computes proportional shares that add up to the total", async () => {
    const response = await request(app)
      .post("/api/splits/preview")
      .send(splitRequest);

    expect(response.status).toBe(200);
    const totals = response.body.shares.map(
      ({ total }: { total: string }) => total,
    );
    const sumCents = totals.reduce(
      (sum: number, total: string) => sum + Math.round(Number(total) * 100),
      0,
    );
    expect(sumCents).toBe(7504);
    expect(response.body.shares[0]).toMatchObject({
      name: "Alex",
      isHost: true,
    });
  });

  test("rejects a receipt that doesn't add up", async () => {
    const response = await request(app)
      .post("/api/splits/preview")
      .send({
        ...splitRequest,
        receipt: { ...splitRequest.receipt, total: "80.00" },
      });

    expect(response.status).toBe(400);
    expect(response.body.errorDescription).toContain("doesn't add up");
  });

  test("rejects an unassigned item", async () => {
    const response = await request(app)
      .post("/api/splits/preview")
      .send({ ...splitRequest, assignments: { "0": ["p0"], "1": ["p1"] } });

    expect(response.status).toBe(400);
    expect(response.body.errorDescription).toContain("Dumplings");
  });

  test("ignores amounts sent by the browser", async () => {
    const response = await request(app)
      .post("/api/splits/preview")
      .send({ ...splitRequest, shares: [{ name: "Ben", total: "0.01" }] });

    // unknown fields are rejected outright rather than silently trusted
    expect(response.status).toBe(400);
  });

  test("creating a split needs the host's PayPal email", async () => {
    const response = await request(app)
      .post("/api/splits")
      .send({
        ...splitRequest,
        host: { id: "p0", name: "Alex" },
      });

    expect(response.status).toBe(400);
    expect(response.body.errorDescription).toContain("PayPal email");
  });

  test("the host dashboard needs the host token", async () => {
    const { split } = await createTestSplit();

    const wrong = await request(app).get(
      `/api/splits/${split.id}?hostToken=nope`,
    );
    expect(wrong.status).toBe(403);

    const right = await request(app).get(
      `/api/splits/${split.id}?hostToken=${split.hostToken}`,
    );
    expect(right.status).toBe(200);
    expect(
      right.body.participants.map((p: { status: string }) => p.status),
    ).toEqual(["host", "pending", "pending"]);
  });

  test("a friend's pay link creates an order paying the HOST their stored share", async () => {
    const { split, ben, payToken } = await createTestSplit();

    const view = await request(app).get(
      `/api/splits/${split.id}/pay/${payToken}`,
    );
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      hostName: "Alex",
      merchantName: "Lantern Noodle House",
      status: "pending",
    });
    expect(view.body).not.toHaveProperty("hostEmail");

    const response = await request(app)
      .post(`/api/splits/${split.id}/pay/${payToken}/create-order`)
      .send({ amount: "0.01" }); // ignored

    expect(response.status).toBe(201);
    const { body } = createOrderMock.mock.calls[0][0];
    expect(body.purchaseUnits[0].payee).toEqual({
      emailAddress: "sb-host@personal.example.com",
    });
    expect(body.purchaseUnits[0].amount.value).toBe(ben.total);
    expect(body.purchaseUnits[0].customId).toBe(`${split.id}:p1`);
  });

  test("an unknown pay token is a 404", async () => {
    const { split } = await createTestSplit();
    const response = await request(app).get(
      `/api/splits/${split.id}/pay/not-a-token`,
    );
    expect(response.status).toBe(404);
  });

  test("capturing marks the share paid, and it can't be paid twice", async () => {
    const { split, ben, payToken } = await createTestSplit();
    await request(app).post(
      `/api/splits/${split.id}/pay/${payToken}/create-order`,
    );
    captureOrderMock.mockResolvedValueOnce(completedCapture(ben.total));

    const capture = await request(app)
      .post(`/api/splits/${split.id}/pay/${payToken}/capture`)
      .send({ orderId: "ORDER-1" });
    expect(capture.status).toBe(201);
    expect(capture.body.status).toBe("COMPLETED");

    const dashboard = await request(app).get(
      `/api/splits/${split.id}?hostToken=${split.hostToken}`,
    );
    expect(dashboard.body.collected).toBe(ben.total);
    expect(
      dashboard.body.participants.find(
        (p: { name: string }) => p.name === "Ben",
      ).status,
    ).toBe("paid");

    const again = await request(app).post(
      `/api/splits/${split.id}/pay/${payToken}/create-order`,
    );
    expect(again.status).toBe(409);
  });

  test("a retried capture of the same order reports success without capturing again", async () => {
    const { split, ben, payToken } = await createTestSplit();
    await request(app).post(
      `/api/splits/${split.id}/pay/${payToken}/create-order`,
    );
    captureOrderMock.mockResolvedValueOnce(completedCapture(ben.total));
    await request(app)
      .post(`/api/splits/${split.id}/pay/${payToken}/capture`)
      .send({ orderId: "ORDER-1" });

    const retry = await request(app)
      .post(`/api/splits/${split.id}/pay/${payToken}/capture`)
      .send({ orderId: "ORDER-1" });

    expect(retry.status).toBe(200);
    expect(captureOrderMock).toHaveBeenCalledTimes(1);
  });

  test("won't capture an order that belongs to a different pay link", async () => {
    const { split, payToken } = await createTestSplit();
    await request(app).post(
      `/api/splits/${split.id}/pay/${payToken}/create-order`,
    );

    const response = await request(app)
      .post(`/api/splits/${split.id}/pay/${payToken}/capture`)
      .send({ orderId: "SOMEONE-ELSES-ORDER" });

    expect(response.status).toBe(400);
    expect(captureOrderMock).not.toHaveBeenCalled();
  });

  test("doesn't mark paid when the captured amount is wrong", async () => {
    const { split, payToken } = await createTestSplit();
    await request(app).post(
      `/api/splits/${split.id}/pay/${payToken}/create-order`,
    );
    captureOrderMock.mockResolvedValueOnce(completedCapture("0.01"));

    const capture = await request(app)
      .post(`/api/splits/${split.id}/pay/${payToken}/capture`)
      .send({ orderId: "ORDER-1" });
    expect(capture.status).toBe(502);
    expect(capture.body.status).toBe("NOT_RECONCILED");

    const view = await request(app).get(
      `/api/splits/${split.id}/pay/${payToken}`,
    );
    expect(view.body.status).toBe("pending");
  });
});
