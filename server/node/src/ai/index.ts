import type { BillExtractor } from "./billSchema";
import { geminiBillExtractor } from "./geminiProvider";

/*
 * Provider registry. To add a provider (e.g. Anthropic or OpenAI), implement
 * the BillExtractor interface in a new file and register it here, then set
 * AI_PROVIDER in the .env file.
 */
const providers: Record<string, BillExtractor> = {
  gemini: geminiBillExtractor,
};

export function getBillExtractor(): BillExtractor {
  const name = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  const provider = providers[name];
  if (!provider) {
    throw new Error(
      `Unknown AI_PROVIDER "${name}". Available: ${Object.keys(providers).join(", ")}`,
    );
  }
  return provider;
}

export * from "./billSchema";
