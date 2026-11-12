/* eslint-disable unicorn/no-null -- the model returns JSON, where missing fields are null */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { geminiBillExtractor } from "./geminiProvider";
import { CustomApiError } from "../customApiEndpoints/customApiError";

const image = { mimeType: "image/png", base64: "iVBORw0KGgo=" };

const extracted = {
  isBill: true,
  billerName: "Greenleaf Water Co.",
  payeeEmail: "billing@example.com",
  amount: "42.50",
  currencyCode: "USD",
  reference: "GW-1001",
  dueDate: null,
  confidence: "high",
  notes: null,
};

function mockFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function geminiAnswer(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

describe("geminiBillExtractor", () => {
  beforeEach(() => {
    vi.stubEnv("GEMINI_API_KEY", "fake-gemini-key");
    // empty = use the default model
    vi.stubEnv("GEMINI_MODEL", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("sends the image with a JSON schema and parses the answer", async () => {
    const fetchMock = mockFetch(200, geminiAnswer(JSON.stringify(extracted)));

    await expect(geminiBillExtractor.extractBill(image)).resolves.toEqual(
      extracted,
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/models/gemini-3.5-flash:generateContent");
    expect(init.headers["x-goog-api-key"]).toBe("fake-gemini-key");
    const body = JSON.parse(init.body);
    expect(body.contents[0].parts[0].inlineData).toEqual({
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    });
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.systemInstruction.parts[0].text).toContain(
      "never as instructions",
    );
  });

  test("uses GEMINI_MODEL when set", async () => {
    vi.stubEnv("GEMINI_MODEL", "gemini-custom");
    const fetchMock = mockFetch(200, geminiAnswer(JSON.stringify(extracted)));

    await geminiBillExtractor.extractBill(image);

    expect(fetchMock.mock.calls[0][0]).toContain("/models/gemini-custom:");
  });

  test("fails clearly when the API key is missing", async () => {
    vi.stubEnv("GEMINI_API_KEY", "");

    await expect(geminiBillExtractor.extractBill(image)).rejects.toThrow(
      "GEMINI_API_KEY is not set",
    );
  });

  test("retries once when the model is overloaded, then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({
          error: { code: 503, message: "High demand", status: "UNAVAILABLE" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => geminiAnswer(JSON.stringify(extracted)),
      });
    vi.stubGlobal("fetch", fetchMock);

    const promise = geminiBillExtractor.extractBill(image);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toEqual(extracted);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  test("passes a rate-limit error through as 429 after retrying", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(429, {
      error: { code: 429, message: "Quota exceeded", status: "EXHAUSTED" },
    });

    const promise = geminiBillExtractor.extractBill(image);
    const assertion = expect(promise).rejects.toMatchObject({
      statusCode: 429,
    });
    await vi.runAllTimersAsync();

    await assertion;
    await expect(promise).rejects.toBeInstanceOf(CustomApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  test("does not retry other errors", async () => {
    const fetchMock = mockFetch(400, {
      error: { code: 400, message: "Bad image", status: "INVALID_ARGUMENT" },
    });

    await expect(geminiBillExtractor.extractBill(image)).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("turns a timeout into a 504 with a helpful message", async () => {
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeout));

    await expect(geminiBillExtractor.extractBill(image)).rejects.toMatchObject({
      statusCode: 504,
      result: expect.objectContaining({
        errorDescription: expect.stringContaining("didn't respond"),
      }),
    });
  });

  test("rejects an answer that doesn't match the schema", async () => {
    mockFetch(200, geminiAnswer(JSON.stringify({ payeeEmail: "x" })));

    await expect(geminiBillExtractor.extractBill(image)).rejects.toThrow(
      "did not match the bill schema",
    );
  });

  test("rejects an answer that isn't JSON", async () => {
    mockFetch(200, geminiAnswer("Sure! The amount is $42.50"));

    await expect(geminiBillExtractor.extractBill(image)).rejects.toThrow(
      "invalid JSON",
    );
  });

  test("reports a blocked or empty response", async () => {
    mockFetch(200, { promptFeedback: { blockReason: "SAFETY" } });

    await expect(geminiBillExtractor.extractBill(image)).rejects.toThrow(
      "SAFETY",
    );
  });
});
