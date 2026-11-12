/* eslint-disable unicorn/no-null -- the model returns JSON, where missing fields are null */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { geminiBillExtractor, getGeminiModels } from "./geminiProvider";
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
    // empty = use the default models
    vi.stubEnv("GEMINI_MODEL", "");
    vi.stubEnv("GEMINI_FALLBACK_MODEL", "");
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
    expect(url).toContain("/models/gemini-3.5-flash-lite:generateContent");
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

  test("falls back to the second model when the first is overloaded", async () => {
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

    await expect(geminiBillExtractor.extractBill(image)).resolves.toEqual(
      extracted,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("/gemini-3.5-flash-lite:");
    expect(fetchMock.mock.calls[1][0]).toContain("/gemini-3-flash-preview:");
  });

  test("falls back to the second model when the first times out", async () => {
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => geminiAnswer(JSON.stringify(extracted)),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(geminiBillExtractor.extractBill(image)).resolves.toEqual(
      extracted,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("passes a rate-limit error through as 429 when every model is limited", async () => {
    const fetchMock = mockFetch(429, {
      error: { code: 429, message: "Quota exceeded", status: "EXHAUSTED" },
    });

    const promise = geminiBillExtractor.extractBill(image);
    await expect(promise).rejects.toBeInstanceOf(CustomApiError);
    await expect(promise).rejects.toMatchObject({ statusCode: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(getGeminiModels().length);
  });

  test("does not fall back on other errors", async () => {
    const fetchMock = mockFetch(400, {
      error: { code: 400, message: "Bad image", status: "INVALID_ARGUMENT" },
    });

    await expect(geminiBillExtractor.extractBill(image)).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("turns a timeout on every model into a 504 with a helpful message", async () => {
    const timeout = new Error("The operation timed out");
    timeout.name = "TimeoutError";
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    vi.stubGlobal("fetch", fetchMock);

    await expect(geminiBillExtractor.extractBill(image)).rejects.toMatchObject({
      statusCode: 504,
      result: expect.objectContaining({
        errorDescription: expect.stringContaining("busy"),
      }),
    });
    expect(fetchMock).toHaveBeenCalledTimes(getGeminiModels().length);
  });

  test("model list honours GEMINI_MODEL and GEMINI_FALLBACK_MODEL", () => {
    expect(getGeminiModels()).toEqual([
      "gemini-3.5-flash-lite",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite",
      "gemini-3.5-flash",
    ]);

    vi.stubEnv("GEMINI_FALLBACK_MODEL", " model-b , model-c,");
    vi.stubEnv("GEMINI_MODEL", "model-a");
    expect(getGeminiModels()).toEqual(["model-a", "model-b", "model-c"]);

    vi.stubEnv("GEMINI_MODEL", "model-a");
    vi.stubEnv("GEMINI_FALLBACK_MODEL", "model-b");
    expect(getGeminiModels()).toEqual(["model-a", "model-b"]);

    vi.stubEnv("GEMINI_FALLBACK_MODEL", "none");
    expect(getGeminiModels()).toEqual(["model-a"]);

    vi.stubEnv("GEMINI_FALLBACK_MODEL", "model-a");
    expect(getGeminiModels()).toEqual(["model-a"]);
  });

  test("rejects an answer that doesn't match the schema", async () => {
    mockFetch(200, geminiAnswer(JSON.stringify({ payeeEmail: "x" })));

    await expect(geminiBillExtractor.extractBill(image)).rejects.toThrow(
      "did not match the expected schema",
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
