import { CustomApiError } from "../customApiEndpoints/customApiError";
import {
  EXTRACTED_BILL_JSON_SCHEMA,
  EXTRACTION_PROMPT,
  ExtractedBillSchema,
  type BillExtractor,
  type BillImage,
} from "./billSchema";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
// gemini-2.5-flash is no longer available to new API keys; 3.5 Flash was
// the fastest reliable model in testing (about 5-8s per bill)
const DEFAULT_MODEL = "gemini-3.5-flash";
const REQUEST_TIMEOUT_MS = 45_000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A slow or stuck model must not leave the user staring at a spinner forever. */
async function fetchWithTimeout(url: string, init: RequestInit) {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new CustomApiError({
      message: timedOut ? "Gemini request timed out" : "Gemini request failed",
      statusCode: timedOut ? 504 : 502,
      result: {
        error: "AI extraction failed",
        errorDescription: timedOut
          ? `The AI model didn't respond within ${REQUEST_TIMEOUT_MS / 1000} seconds. Try again, or fill in the details yourself.`
          : "Couldn't reach the AI model. Check your internet connection.",
      },
    });
  }
}

type GeminiResponse = {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { code: number; message: string; status: string };
};

export const geminiBillExtractor: BillExtractor = {
  name: "gemini",

  async extractBill({ mimeType, base64 }: BillImage) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new CustomApiError({
        message: "GEMINI_API_KEY is not set",
        statusCode: 500,
        result: {
          error: "AI provider not configured",
          errorDescription:
            "Set GEMINI_API_KEY in the .env file (get one at https://aistudio.google.com).",
        },
      });
    }
    const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
    const requestBody = JSON.stringify({
      systemInstruction: { parts: [{ text: EXTRACTION_PROMPT }] },
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType, data: base64 } },
            { text: "Extract the payment details from this document." },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: EXTRACTED_BILL_JSON_SCHEMA,
      },
    });

    // Retry once when the model is overloaded (503) or rate limited (429).
    let response: Response | undefined;
    let result: GeminiResponse = {};
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      response = await fetchWithTimeout(
        `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          body: requestBody,
        },
      );
      result = (await response.json()) as GeminiResponse;

      const retryable = response.status === 429 || response.status === 503;
      if (!retryable || attempt === MAX_ATTEMPTS) {
        break;
      }
      await sleep(RETRY_DELAY_MS);
    }

    if (!response?.ok) {
      throw new CustomApiError({
        message: result.error?.message ?? "Gemini request failed",
        statusCode: response?.status === 429 ? 429 : 502,
        result: {
          error: "AI extraction failed",
          errorDescription: result.error?.message ?? "Gemini request failed",
        },
      });
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
          errorDescription: `The model returned no content (${reason}).`,
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
          errorDescription: "The model returned invalid JSON.",
        },
      });
    }

    const validated = ExtractedBillSchema.safeParse(parsed);
    if (!validated.success) {
      throw new CustomApiError({
        message: "Gemini output did not match the bill schema",
        statusCode: 502,
        result: {
          error: "AI extraction failed",
          errorDescription:
            "The model's answer did not match the expected format.",
        },
      });
    }
    return validated.data;
  },
};
