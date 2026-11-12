import type { z } from "zod/v4";

import { CustomApiError } from "../customApiEndpoints/customApiError";
import {
  EXTRACTED_BILL_JSON_SCHEMA,
  EXTRACTION_PROMPT,
  ExtractedBillSchema,
  type BillExtractor,
  type BillImage,
} from "./billSchema";
import {
  EXTRACTED_RECEIPT_JSON_SCHEMA,
  ExtractedReceiptSchema,
  RECEIPT_EXTRACTION_PROMPT,
} from "./receiptSchema";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/*
 * Model choice, from live testing on a free-tier key (November 2026):
 * - gemini-2.5-flash is no longer available to new API keys.
 * - gemini-3.5-flash was often overloaded (503) or slow (it "thinks" first).
 * - gemini-3.5-flash-lite answered in about 2-7s, read every sample bill
 *   correctly and refused the tampered bill's injected instruction.
 * When the primary model is busy, rate limited or slow, we switch to a
 * fallback model rather than retrying the busy one. Free-tier rate limits
 * are per model, so switching also sidesteps a 429.
 */
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_FALLBACK_MODEL = "gemini-3-flash-preview";
const REQUEST_TIMEOUT_MS = 20_000;

/** The models to try, in order. GEMINI_FALLBACK_MODEL=none disables the fallback. */
export function getGeminiModels() {
  const primary = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const fallback = process.env.GEMINI_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
  return fallback === "none" || fallback === primary
    ? [primary]
    : [primary, fallback];
}

type GeminiResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { code: number; message: string; status: string };
};

type ModelAttempt =
  | { ok: true; result: GeminiResponse }
  | { ok: false; retryable: boolean; error: CustomApiError };

async function callModel(
  model: string,
  apiKey: string,
  requestBody: string,
): Promise<ModelAttempt> {
  let response: Response;
  try {
    response = await fetch(
      `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: requestBody,
        // a slow or stuck model must not leave the user staring at a spinner
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      ok: false,
      retryable: timedOut,
      error: new CustomApiError({
        message: timedOut
          ? `Gemini model ${model} timed out`
          : "Gemini request failed",
        statusCode: timedOut ? 504 : 502,
        result: {
          error: "AI extraction failed",
          errorDescription: timedOut
            ? "The AI model is busy and didn't respond in time. Try again in a moment"
            : "Couldn't reach the AI model. Check your internet connection",
        },
      }),
    };
  }

  const result = (await response.json()) as GeminiResponse;
  if (response.ok) {
    return { ok: true, result };
  }

  const message = result.error?.message ?? "Gemini request failed";
  return {
    ok: false,
    // 503 = model overloaded, 429 = rate limit (per model on the free tier)
    retryable: response.status === 429 || response.status === 503,
    error: new CustomApiError({
      message,
      statusCode: response.status === 429 ? 429 : 502,
      result: { error: "AI extraction failed", errorDescription: message },
    }),
  };
}

type StructuredRequest<T> = {
  image: BillImage;
  prompt: string;
  instruction: string;
  jsonSchema: unknown;
  zodSchema: z.ZodType<T>;
};

/**
 * Sends an image to Gemini and returns JSON validated against `zodSchema`,
 * with the model fallback and timeout from callModel. Shared by every
 * extraction (bills, receipts) so they all fail the same, safe way.
 */
async function generateStructuredJson<T>({
  image,
  prompt,
  instruction,
  jsonSchema,
  zodSchema,
}: StructuredRequest<T>): Promise<T> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new CustomApiError({
      message: "GEMINI_API_KEY is not set",
      statusCode: 500,
      result: {
        error: "AI provider not configured",
        errorDescription:
          "Set GEMINI_API_KEY in the .env file (get one at https://aistudio.google.com), then restart the server",
      },
    });
  }

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: prompt }] },
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: image.mimeType, data: image.base64 } },
          { text: instruction },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: jsonSchema,
    },
  });

  let result: GeminiResponse | undefined;
  let lastError: CustomApiError | undefined;
  for (const model of getGeminiModels()) {
    const attempt = await callModel(model, apiKey, requestBody);
    if (attempt.ok) {
      result = attempt.result;
      break;
    }
    lastError = attempt.error;
    if (!attempt.retryable) {
      break;
    }
    console.warn(`${attempt.error.message}; trying the next model`);
  }

  if (!result) {
    throw lastError;
  }

  const text = result.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("");

  if (!text) {
    const reason =
      result.promptFeedback?.blockReason ??
      result.candidates?.[0]?.finishReason ??
      "empty response";
    throw new CustomApiError({
      message: `Gemini returned no content (${reason})`,
      statusCode: 502,
      result: {
        error: "AI extraction failed",
        errorDescription: `The model returned no content (${reason})`,
      },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CustomApiError({
      message: "Gemini returned invalid JSON",
      statusCode: 502,
      result: {
        error: "AI extraction failed",
        errorDescription: "The model returned invalid JSON",
      },
    });
  }

  const validated = zodSchema.safeParse(parsed);
  if (!validated.success) {
    throw new CustomApiError({
      message: "Gemini output did not match the expected schema",
      statusCode: 502,
      result: {
        error: "AI extraction failed",
        errorDescription:
          "The model's answer did not match the expected format",
      },
    });
  }
  return validated.data;
}

export const geminiBillExtractor: BillExtractor = {
  name: "gemini",

  extractBill(image: BillImage) {
    return generateStructuredJson({
      image,
      prompt: EXTRACTION_PROMPT,
      instruction: "Extract the payment details from this document.",
      jsonSchema: EXTRACTED_BILL_JSON_SCHEMA,
      zodSchema: ExtractedBillSchema,
    });
  },

  extractReceipt(image: BillImage) {
    return generateStructuredJson({
      image,
      prompt: RECEIPT_EXTRACTION_PROMPT,
      instruction: "Extract every line of this receipt.",
      jsonSchema: EXTRACTED_RECEIPT_JSON_SCHEMA,
      zodSchema: ExtractedReceiptSchema,
    });
  },
};
