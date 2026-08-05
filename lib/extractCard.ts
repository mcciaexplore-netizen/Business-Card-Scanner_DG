import { runOcr } from "./ocr";
import { parseCardText } from "./parseCardText";
import { extractCardFields } from "./gemini";
import { smartExtractCard } from "./enhancement/smartExtractor";
import { CardFields } from "./types";

const OCR_CONFIDENCE_THRESHOLD = 70;

/**
 * Enhanced OCR-first extraction:
 * Uses smartExtractCard (OpenCV + RapidOCR + Text-Only Gemini LLM) to minimize cost locally.
 * Falls back to fast Gemini Vision call if local OCR fails or takes longer than 3.5s.
 */
export async function extractCard(imageBytes: Buffer): Promise<CardFields> {
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const MAX_SMART_TIMEOUT = isServerless ? 3000 : 8000;

  try {
    const smartPromise = smartExtractCard(imageBytes);
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), MAX_SMART_TIMEOUT)
    );

    const smartFields = await Promise.race([smartPromise, timeoutPromise]);
    if (smartFields) {
      return smartFields;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(`[extractCard] Smart enhancement layer exception (${message}) - falling back to Gemini Vision`);
  }

  console.log(`[extractCard] Running Cloud Gemini Vision API extraction...`);
  return extractCardFields(imageBytes);
}
