import { runOcr, runOcrRich } from "../ocr";
import { parseCardText } from "../parseCardText";
import { isOcrServiceAvailable, runRapidOcr } from "./rapidOcrClient";
import { extractCardFieldsLocalNlp } from "./localNlpExtractor";
import { extractFieldsFromOcrText } from "./textGemini";
import { CardFields } from "../types";
import {
  OcrCandidate,
  isOcrCandidateUsable,
  selectBestOcrCandidate,
} from "./ocrPolicy";

// ─────────────────────────────────────────────────────────────────────────────
// Validation helpers
// ─────────────────────────────────────────────────────────────────────────────

/** OCR noise score for a single field value. */
function fieldNoiseScore(value: string): number {
  if (!value) return 0;
  const noiseChars = (value.match(/[^a-zA-Z0-9\s@.\-+()\/&,'.]/g) || []).length;
  return noiseChars / value.length;
}

/**
 * Returns true if a Name field looks clean enough to trust.
 * Rejects: starts with non-alpha, has 4+ consecutive digits,
 * contains high-noise chars, too short/long.
 */
function isCleanName(name: string): boolean {
  if (!name || name.length < 3 || name.length > 50) return false;
  if (/^[\d\W]/.test(name)) return false;
  if (/\d{4,}/.test(name)) return false;
  if (fieldNoiseScore(name) > 0.35) return false;
  // Must have at least one proper word starting with a capital letter
  const words = name.trim().split(/\s+/);
  return words.some((w) => /^[A-Z][a-z]/.test(w));
}

/**
 * Returns true if a Company name looks plausibly real.
 * Rejects: too short, starts with a digit only, high-noise.
 */
function isCleanCompany(company: string): boolean {
  if (!company || company.length < 3) return false;
  if (/^\d+$/.test(company.trim())) return false;  // pure number = garbage
  if (fieldNoiseScore(company) > 0.4) return false;
  return true;
}

/**
 * Returns true if a Designation looks plausibly real.
 * Rejects: too short, high-noise, starts with non-alpha.
 */
function isCleanDesignation(designation: string): boolean {
  if (!designation || designation.length < 3) return false;
  if (/^[\d\W]/.test(designation)) return false;
  if (fieldNoiseScore(designation) > 0.4) return false;
  return true;
}

/**
 * Returns true if an Address looks plausibly real.
 * Rejects: very high-noise, pure symbols.
 */
function isCleanAddress(address: string): boolean {
  if (!address || address.length < 3) return false;
  if (fieldNoiseScore(address) > 0.5) return false;
  return true;
}

/**
 * Applies validation gate to merged fields.
 * Nullifies (sets to "") any field that fails its cleanliness check
 * so that garbage does not appear in the final output.
 */
function validateAndSanitiseFields(f: CardFields): CardFields {
  return {
    Name:        isCleanName(f.Name)           ? f.Name        : "",
    Company:     isCleanCompany(f.Company)     ? f.Company     : "",
    Industry:    f.Industry,
    Designation: isCleanDesignation(f.Designation) ? f.Designation : "",
    Phone:       f.Phone,   // Phone is extracted by strict regex — always trust it
    Email:       f.Email,   // Email is extracted by strict regex — always trust it
    Website:     f.Website, // Website is extracted by strict regex — always trust it
    Address:     isCleanAddress(f.Address)     ? f.Address     : "",
    "Extraction Engine": f["Extraction Engine"],
  };
}

/**
 * Smart field-level merge of Tier 1 and Tier 2 results.
 * For each field, prefer the result from whichever tier produced a
 * cleaner (lower noise score) non-empty value.
 */
function smartMerge(t1: CardFields, t2: CardFields): CardFields {
  function pick(v1: string, v2: string): string {
    if (!v1 && !v2) return "";
    if (!v1) return v2;
    if (!v2) return v1;
    // Both non-empty: prefer the one with lower noise score
    const n1 = fieldNoiseScore(v1);
    const n2 = fieldNoiseScore(v2);
    return n1 <= n2 ? v1 : v2;
  }

  return {
    Name:        pick(t2.Name, t1.Name),
    Company:     pick(t2.Company, t1.Company),
    Industry:    pick(t2.Industry, t1.Industry),
    Designation: pick(t2.Designation, t1.Designation),
    Phone:       pick(t2.Phone, t1.Phone),
    Email:       pick(t2.Email, t1.Email),
    Website:     pick(t2.Website, t1.Website),
    Address:     pick(t2.Address, t1.Address),
    "Extraction Engine": pick(t2["Extraction Engine"], t1["Extraction Engine"]),
  };
}

/**
 * Returns true if the extracted fields are considered "successfully complete":
 * at minimum, a clean name AND at least one of phone/email/company.
 */
function isExtractionSuccessful(f: CardFields): boolean {
  return Boolean(
    isCleanName(f.Name) &&
    (f.Phone || f.Email || isCleanCompany(f.Company))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main smart extractor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Confidence-gated extraction pipeline:
 * 1. Tesseract (local development) with a 70% confidence requirement.
 * 2. RapidOCR sidecar when Tesseract is unavailable, below 70%, or incomplete.
 * 3. Gemini text parsing of the best OCR text.
 * 4. Gemini Vision fallback in extractCard() when all earlier stages fail.
 */
function parseLocalCandidate(
  candidate: OcrCandidate,
  richOcrResult: Awaited<ReturnType<typeof runOcrRich>> | null = null
): { accepted: CardFields | null; partial: CardFields | null } {
  if (!isOcrCandidateUsable(candidate)) {
    console.log(
      `[smartExtractor] ${candidate.engine} not accepted locally ` +
      `(confidence=${candidate.confidence.toFixed(1)}, minimum=70, textLength=${candidate.text.trim().length})`
    );
    return { accepted: null, partial: null };
  }

  const { fields: t1Fields, missingRequired } = parseCardText(candidate.text);
  const t2Fields = extractCardFieldsLocalNlp(richOcrResult ?? candidate.text);
  const validated = validateAndSanitiseFields(smartMerge(t1Fields, t2Fields));

  if (!missingRequired && isExtractionSuccessful(validateAndSanitiseFields(t1Fields))) {
    const accepted = validateAndSanitiseFields(t1Fields);
    console.log(`[smartExtractor] ${candidate.engine} accepted by the fast parser at ${candidate.confidence.toFixed(1)}%`);
    return { accepted, partial: accepted };
  }

  if (isExtractionSuccessful(validated)) {
    console.log(`[smartExtractor] ${candidate.engine} accepted by the positional parser at ${candidate.confidence.toFixed(1)}%`);
    return { accepted: validated, partial: validated };
  }

  console.log(`[smartExtractor] ${candidate.engine} passed 70% confidence but did not produce a complete card`);
  return { accepted: null, partial: validated };
}

interface SmartExtractionResult {
  fields: CardFields;
  engine: string;
}

export async function smartExtractCard(imageBytes: Buffer): Promise<SmartExtractionResult | null> {
  const candidates: OcrCandidate[] = [];
  const partialResults: Array<{ fields: CardFields; confidence: number }> = [];

  const rememberPartial = (fields: CardFields | null, confidence: number) => {
    if (fields) partialResults.push({ fields, confidence });
  };

  // NEXT_RUNTIME is also set by local Next.js. VERCEL/AWS are the actual
  // signals used here to avoid starting a Tesseract worker in serverless.
  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

  // ── OCR stage 1: Tesseract ────────────────────────────────────────────────
  if (!isServerless) {
    let richOcrResult: Awaited<ReturnType<typeof runOcrRich>> | null = null;
    let tesseractCandidate: OcrCandidate | null = null;

    try {
      richOcrResult = await runOcrRich(imageBytes);
      tesseractCandidate = {
        engine: "tesseract",
        text: richOcrResult.text,
        confidence: richOcrResult.confidence,
      };
      console.log(
        `[smartExtractor] Tesseract executed ` +
        `(confidence=${richOcrResult.confidence.toFixed(1)}, lines=${richOcrResult.lines.length})`
      );
    } catch (richError) {
      console.log(`[smartExtractor] Rich Tesseract failed; trying plain Tesseract: ${richError}`);
      try {
        const plainResult = await runOcr(imageBytes);
        tesseractCandidate = {
          engine: "tesseract",
          text: plainResult.text,
          confidence: plainResult.confidence,
        };
        console.log(`[smartExtractor] Plain Tesseract executed (confidence=${plainResult.confidence.toFixed(1)})`);
      } catch (plainError) {
        console.log(`[smartExtractor] Tesseract failed: ${plainError}`);
      }
    }

    if (tesseractCandidate) {
      candidates.push(tesseractCandidate);
      const result = parseLocalCandidate(tesseractCandidate, richOcrResult);
      if (result.accepted) {
        return { fields: result.accepted, engine: "Tesseract OCR" };
      }
      rememberPartial(result.partial, tesseractCandidate.confidence);
    }
  }

  // ── OCR stage 2: RapidOCR sidecar ────────────────────────────────────────
  // This stage intentionally runs after Tesseract and before either Gemini
  // fallback. It is tried when Tesseract is unavailable, below 70%, or unable
  // to produce a complete card.
  const serviceUp = await isOcrServiceAvailable();
  if (serviceUp) {
    try {
      const rapidResult = await runRapidOcr(imageBytes);
      const rapidCandidate: OcrCandidate = {
        engine: "rapidocr",
        text: rapidResult.text,
        confidence: rapidResult.confidence,
      };
      candidates.push(rapidCandidate);
      console.log(`[smartExtractor] RapidOCR executed (confidence=${rapidResult.confidence.toFixed(1)})`);

      const result = parseLocalCandidate(rapidCandidate);
      if (result.accepted) {
        return { fields: result.accepted, engine: "RapidOCR" };
      }
      rememberPartial(result.partial, rapidCandidate.confidence);
    } catch (error) {
      console.log(`[smartExtractor] RapidOCR failed: ${error}`);
    }
  } else {
    console.log(`[smartExtractor] RapidOCR sidecar unavailable; continuing to Gemini fallback`);
  }

  // ── Cloud stage 3A: Gemini text parser ───────────────────────────────────
  const bestCandidate = selectBestOcrCandidate(candidates);
  if (!bestCandidate) {
    console.log(`[smartExtractor] No OCR engine produced enough text; continuing to Gemini Vision`);
    return null;
  }

  try {
    console.log(
      `[smartExtractor] Sending ${bestCandidate.engine} text to the Gemini text parser`
    );
    const cloudFields = await extractFieldsFromOcrText(bestCandidate.text);

    if (cloudFields.Name || cloudFields.Phone || cloudFields.Email) {
      const localFields = partialResults.sort((a, b) => b.confidence - a.confidence)[0]?.fields;
      const t3Merged: CardFields = {
        Name:        cloudFields.Name        || localFields?.Name        || "",
        Company:     cloudFields.Company     || localFields?.Company     || "",
        Industry:    cloudFields.Industry    || localFields?.Industry    || "",
        Designation: cloudFields.Designation || localFields?.Designation || "",
        Phone:       cloudFields.Phone       || localFields?.Phone       || "",
        Email:       cloudFields.Email       || localFields?.Email       || "",
        Website:     cloudFields.Website     || localFields?.Website     || "",
        Address:     cloudFields.Address     || localFields?.Address     || "",
        "Extraction Engine": "",
      };
      console.log(`[smartExtractor] Gemini text parser extracted a usable card`);
      const sourceEngine = bestCandidate.engine === "tesseract" ? "Tesseract OCR" : "RapidOCR";
      return {
        fields: t3Merged,
        engine: `Gemini Text fallback (${sourceEngine} input)`,
      };
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(`[smartExtractor] Gemini text parser failed (${message}); continuing to Gemini Vision`);
  }

  return null;
}
