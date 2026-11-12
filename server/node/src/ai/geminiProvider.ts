import { CustomApiError } from "../customApiEndpoints/customApiError";
import {
  EXTRACTED_BILL_JSON_SCHEMA,
  EXTRACTION_PROMPT,
  ExtractedBillSchema,
  type BillExtractor,
  type BillImage,
} from "./billSchema";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-2.5-flash";

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

    const response = await fetch(
      `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
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
        }),
      },
    );

    const result = (await response.json()) as GeminiResponse;

    if (!response.ok) {
      throw new CustomApiError({
        message: result.error?.message ?? "Gemini request failed",
        statusCode: response.status === 429 ? 429 : 502,
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
