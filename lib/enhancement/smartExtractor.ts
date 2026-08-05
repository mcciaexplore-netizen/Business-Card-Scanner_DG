import { runOcr, runOcrRich } from "../ocr";
import { parseCardText } from "../parseCardText";
import { isOcrServiceAvailable, runRapidOcr } from "./paddleOcrClient";
import { extractCardFieldsLocalNlp } from "./localNlpExtractor";
import { extractFieldsFromOcrText } from "./textGemini";
import { CardFields } from "../types";

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
    Designation: isCleanDesignation(f.Designation) ? f.Designation : "",
    Phone:       f.Phone,   // Phone is extracted by strict regex — always trust it
    Email:       f.Email,   // Email is extracted by strict regex — always trust it
    Website:     f.Website, // Website is extracted by strict regex — always trust it
    Address:     isCleanAddress(f.Address)     ? f.Address     : "",
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
    Designation: pick(t2.Designation, t1.Designation),
    Phone:       pick(t2.Phone, t1.Phone),
    Email:       pick(t2.Email, t1.Email),
    Website:     pick(t2.Website, t1.Website),
    Address:     pick(t2.Address, t1.Address),
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
 * 100% Zero-Cost Hybrid 3-Tier Business Card Extraction Architecture:
 * - Tier 1: Local OCR + Fast Pattern Regex Parser → ₹0.00 Cost (100% Offline)
 * - Tier 2: Local OCR + Advanced Positional NLP Engine → ₹0.00 Cost (100% Offline)
 * - Tier 3: Emergency Cloud Fallback (Text API ~₹0.003, Vision API ~₹0.25)
 *
 * Key improvements:
 * - Rich OCR (bbox + word-level confidence) passed to Tier 2 for spatial analysis
 * - Validation gate rejects garbage fields before declaring success
 * - Smart field-level merge prefers lower-noise result per field
 * - Tighter success criterion: name must pass isCleanName()
 */
export async function smartExtractCard(imageBytes: Buffer): Promise<CardFields | null> {
  let ocrText = "";
  let ocrConfidence = 0;

  // ── Step 1: Run local OCR (RapidOCR → Tesseract) ─────────────────────────
  const serviceUp = await isOcrServiceAvailable();
  if (serviceUp) {
    try {
      const res = await runRapidOcr(imageBytes);
      ocrText = res.text;
      ocrConfidence = res.confidence;
      console.log(`[smartExtractor] RapidOCR executed (confidence=${ocrConfidence.toFixed(1)})`);
    } catch (e) {
      console.log(`[smartExtractor] RapidOCR failed, trying Tesseract: ${e}`);
    }
  }

  const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NEXT_RUNTIME);

  // Attempt rich Tesseract OCR for bbox-aware Tier 2 (only in local non-serverless mode)
  let richOcrResult = null;
  if (!ocrText && !isServerless) {
    try {
      richOcrResult = await runOcrRich(imageBytes);
      ocrText = richOcrResult.text;
      ocrConfidence = richOcrResult.confidence;
      console.log(
        `[smartExtractor] Tesseract Rich OCR executed (confidence=${ocrConfidence.toFixed(1)}, lines=${richOcrResult.lines.length})`
      );
    } catch (e) {
      console.log(`[smartExtractor] Tesseract Rich OCR failed, trying plain OCR: ${e}`);
    }
  }

  // Plain Tesseract fallback if rich failed
  if (!ocrText && !isServerless) {
    try {
      const res = await runOcr(imageBytes);
      ocrText = res.text;
      ocrConfidence = res.confidence;
      console.log(`[smartExtractor] Tesseract Plain OCR executed (confidence=${ocrConfidence.toFixed(1)})`);
    } catch (e) {
      console.log(`[smartExtractor] Tesseract Plain OCR also failed: ${e}`);
    }
  }

  if (!ocrText || ocrText.trim().length < 15) {
    console.log(`[smartExtractor] OCR text insufficient (<15 chars) — triggering Tier 3 Cloud Fallback`);
    return null;
  }

  // ── Step 2: Tier 1 — Fast Regex Parser ───────────────────────────────────
  const { fields: t1Fields, missingRequired: t1Missing } = parseCardText(ocrText);
  console.log(
    `[smartExtractor] Tier 1 result — Name: "${t1Fields.Name}", Company: "${t1Fields.Company}", Designation: "${t1Fields.Designation}", Phone: "${t1Fields.Phone}", Email: "${t1Fields.Email}"`
  );

  if (!t1Missing && isExtractionSuccessful(t1Fields)) {
    const validated = validateAndSanitiseFields(t1Fields);
    if (isExtractionSuccessful(validated)) {
      console.log(
        `[smartExtractor] ✅ Tier 1 Success (Cost: ₹0.00) — Name: "${validated.Name}", Phone: "${validated.Phone}", Email: "${validated.Email}"`
      );
      return validated;
    }
  }

  // ── Step 3: Tier 2 — Advanced Positional NLP Engine ──────────────────────
  console.log(`[smartExtractor] Tier 1 incomplete. Running Tier 2 Positional NLP Engine (Cost: ₹0.00)...`);

  // Pass rich OCR data to Tier 2 if available for positional scoring
  const t2Fields = extractCardFieldsLocalNlp(richOcrResult ?? ocrText);
  console.log(
    `[smartExtractor] Tier 2 result — Name: "${t2Fields.Name}", Company: "${t2Fields.Company}", Designation: "${t2Fields.Designation}", Phone: "${t2Fields.Phone}", Email: "${t2Fields.Email}"`
  );

  // Smart field-level merge: pick the cleaner value per field
  const merged = smartMerge(t1Fields, t2Fields);
  const validated = validateAndSanitiseFields(merged);

  console.log(
    `[smartExtractor] Merged result — Name: "${validated.Name}", Company: "${validated.Company}", Designation: "${validated.Designation}"`
  );

  if (isExtractionSuccessful(validated)) {
    console.log(
      `[smartExtractor] ✅ Tier 2 Success (Cost: ₹0.00, 100% Offline) — Name: "${validated.Name}"`
    );
    return validated;
  }

  // ── Step 4: Tier 3A — Cloud Gemini Text API (last resort) ─────────────────
  try {
    console.log(
      `[smartExtractor] ⚡ Tier 3A Triggered: Sending OCR text to Cloud Gemini Text API (Cost: ~₹0.003)...`
    );
    const cloudFields = await extractFieldsFromOcrText(ocrText);

    if (cloudFields.Name || cloudFields.Phone || cloudFields.Email) {
      const t3Merged: CardFields = {
        Name:        cloudFields.Name        || validated.Name        || "",
        Company:     cloudFields.Company     || validated.Company     || "",
        Designation: cloudFields.Designation || validated.Designation || "",
        Phone:       cloudFields.Phone       || validated.Phone       || "",
        Email:       cloudFields.Email       || validated.Email       || "",
        Website:     cloudFields.Website     || validated.Website     || "",
        Address:     cloudFields.Address     || validated.Address     || "",
      };
      console.log(`[smartExtractor] ✅ Tier 3A Success: Cloud Gemini Text API extracted fields!`);
      return t3Merged;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.log(`[smartExtractor] Tier 3A Failed (${message}) — falling back to Tier 3B Gemini Vision`);
  }

  return null; // Triggers Tier 3B Gemini Vision fallback
}
