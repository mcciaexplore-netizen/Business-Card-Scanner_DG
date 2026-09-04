import { extractCardFields } from "./gemini";
import { smartExtractCard } from "./enhancement/smartExtractor";
import { CardFields } from "./types";
import { withDetectedIndustry } from "./industry";
import { normalizePhoneNumbers } from "./phone";

function finalizeCard(fields: CardFields, engine: string): CardFields {
  const classified = withDetectedIndustry(fields);
  return {
    ...classified,
    Phone: normalizePhoneNumbers(classified.Phone),
    "Extraction Engine": engine,
  };
}

/**
 * Enhanced OCR-first extraction:
 * Tesseract runs first, RapidOCR is the second 70%-confidence OCR stage,
 * Gemini text parses the best OCR output, and Gemini Vision is the final fallback.
 */
export async function extractCard(imageBytes: Buffer): Promise<CardFields> {
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  // The old 3-second serverless deadline prevented the 5-second RapidOCR
  // request from ever finishing. Leave enough time for the requested second
  // OCR stage while retaining headroom inside the route's 60-second limit.
  const MAX_SMART_TIMEOUT = isServerless ? 10000 : 20000;

  try {
    const smartPromise = smartExtractCard(imageBytes);
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), MAX_SMART_TIMEOUT)
    );

    const smartFields = await Promise.race([smartPromise, timeoutPromise]);
    if (smartFields) {
      return finalizeCard(smartFields.fields, smartFields.engine);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(`[extractCard] Smart enhancement layer exception (${message}) - falling back to Gemini Vision`);
  }

  console.log(`[extractCard] Running Cloud Gemini Vision API extraction...`);
  return finalizeCard(await extractCardFields(imageBytes), "Gemini Vision fallback");
}
