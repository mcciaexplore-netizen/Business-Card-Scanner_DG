import { CardFields, emptyFields } from "../types";
import type { OcrLine, OcrRichResult } from "../ocr";

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic field regexes (same proven patterns as Tier 1)
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_RE =
  /[a-zA-Z0-9][a-zA-Z0-9._%+\-]*@[a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,}/i;

const PHONE_RE =
  /(\+?[\d][\d\s\(\)\-\.]{4,}[\d])/g;

const WEBSITE_RE =
  /((?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9\-]+\.(?:com|in|co|org|net|io|ai|tech|app|me|info|biz|co\.in|net\.in|edu|gov|org\.in|us|uk|ca|de|fr)(?:\/[^\s]*)?)/i;

const LABEL_PREFIX_RE =
  /^(phone|mobile|mob|tel|telephone|fax|cell|email|e-mail|web|website|url|address|add|addr)\s*[:\-]?\s*/i;

// ─────────────────────────────────────────────────────────────────────────────
// Keyword lists
// ─────────────────────────────────────────────────────────────────────────────

const DESIGNATION_KEYWORDS = [
  "ceo", "cto", "cfo", "coo", "cmo", "cio", "chro", "cro", "cpo",
  "chief executive officer", "chief technology officer", "chief financial officer",
  "chief operating officer", "chief marketing officer",
  "founder", "co-founder", "cofounder", "president", "vice president", "vp",
  "svp", "evp", "avp", "executive vice president", "senior vice president",
  "assistant vice president", "director", "managing director", "executive director",
  "non-executive director", "chairman", "chairperson", "chairwoman",
  "partner", "senior partner", "managing partner", "proprietor",
  "owner", "co-owner", "principal", "head of", "country head", "global head",
  "general manager", "gm", "manager", "senior manager", "sr. manager",
  "assistant manager", "asst. manager", "deputy manager", "branch manager",
  "regional manager", "area manager", "project manager", "product manager",
  "program manager", "operations manager", "sales manager", "marketing manager",
  "business development manager", "bdm", "account manager",
  "architect", "solutions architect", "software engineer", "senior software engineer",
  "sr. software engineer", "sr. engineer", "lead engineer", "principal engineer",
  "staff engineer", "engineer", "data scientist", "devops engineer",
  "system administrator", "sysadmin", "qa manager", "ui/ux designer",
  "tech lead", "team lead", "lead", "developer", "designer",
  "assistant", "asst.", "asst", "personal assistant", "executive assistant",
  "office assistant", "admin", "administrator", "coordinator", "specialist",
  "consultant", "senior consultant", "analyst", "senior analyst",
  "associate", "senior associate", "supervisor", "officer",
  "executive", "senior executive", "representative", "agent", "advisor",
  "sales executive", "marketing executive",
];

const COMPANY_KEYWORDS = [
  "pvt. ltd.", "private limited", "pvt ltd", "ltd.", "limited", "pvt.", "pvt",
  "inc.", "inc", "incorporated", "corp.", "corp", "corporation", "llc", "llp",
  "group", "technologies", "technology", "solutions", "enterprises", "industries",
  "company", "co.", "services", "systems", "consulting", "international",
  "global", "holdings", "ventures", "infotech", "labs", "studio", "studios",
  "agency", "media", "works", "logistics", "pharma", "finance", "financial",
  "capital", "associates", "foundation", "trust", "exports", "imports",
  "traders", "trading", "motors", "builders", "developers", "realty", "properties",
  "medical", "healthcare", "hospital", "clinic", "diagnostics", "devices",
];

const ADDRESS_HINT_RE =
  /\b(street|st\.?|road|rd\.?|avenue|ave\.?|floor|suite|ste\.?|block|building|bldg|city|lane|ln\.?|drive|dr\.?|sector|colony|nagar|puram|marg|plot|phase|dist|district|state|country|india|mumbai|delhi|bangalore|bengaluru|pune|hyderabad|chennai|kolkata|ahmedabad|near|behind|opp\.?|opposite)\b/i;

const POSTAL_CODE_RE = /\b\d{5,6}\b/;

const NOISE_LINE_RE =
  /^(services|products|our\s+services|branch\s+office|head\s+office|iso\s*\d+|contact\s+us|visit\s+us|company\s+profile|business\s+card|phone|email|website|address|www\.)$/i;

// ─────────────────────────────────────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────────────────────────────────────

function escapeKw(kw: string): string {
  return kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsKeyword(line: string, keywords: string[]): boolean {
  const lower = line.toLowerCase();
  return keywords.some((k) => new RegExp(`\\b${escapeKw(k)}\\b`, "i").test(lower));
}

function digitCount(s: string): number {
  return (s.match(/\d/g) || []).length;
}

/** OCR noise score 0-1. >0.5 = predominantly garbage. */
function lineNoiseScore(line: string): number {
  if (!line || line.length === 0) return 1;
  const noiseChars = (line.match(/[^a-zA-Z0-9\s@.\-+()\/&,']/g) || []).length;
  const ratio = noiseChars / line.length;
  if (line.length <= 4 && ratio > 0) return 0.8;
  return ratio;
}

function stripLeadingArtifacts(line: string): string {
  return line.replace(/^[\s\W\d]{1,5}(?=[A-Za-z])/, "").trim();
}

function stripTrailingArtifacts(line: string): string {
  return line.replace(/\s+\b[A-Z]{1,2}\b\s*$/, "").trim();
}

function cleanLine(line: string): string {
  let clean = line
    .replace(/[•·|~*°»«©®™℠]+/g, " ")
    .replace(/[^a-zA-Z0-9\s@.\-+()\/&,']/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  clean = stripLeadingArtifacts(clean);
  clean = stripTrailingArtifacts(clean);
  return clean;
}

function fixEmailTypos(email: string): string {
  return email
    .toLowerCase()
    .replace(/\s*@\s*/, "@")
    .replace(/gma1l\.com$/, "gmail.com")
    .replace(/gmaill\.com$/, "gmail.com")
    .replace(/yaho0\.com$/, "yahoo.com")
    .replace(/hotma1l\.com$/, "hotmail.com")
    .replace(/\.c0m$/, ".com")
    .replace(/\.co\.1n$/, ".co.in");
}

/** Clean a designation line by finding the first keyword and extracting from there. */
function extractDesignationFromDirtyLine(line: string): string {
  const lower = line.toLowerCase();
  let bestIdx = line.length;
  let bestKw = "";
  for (const kw of DESIGNATION_KEYWORDS) {
    const re = new RegExp(`\\b${escapeKw(kw)}\\b`, "i");
    const m = re.exec(lower);
    if (m && m.index < bestIdx) {
      bestIdx = m.index;
      bestKw = kw;
    }
  }
  if (!bestKw) return line;
  const extracted = line.substring(bestIdx).trim();
  return stripTrailingArtifacts(extracted);
}

// ─────────────────────────────────────────────────────────────────────────────
// Positional / font-size scoring for Tier 2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalised vertical position of the top of a line within the image.
 * 0.0 = very top, 1.0 = very bottom.
 */
function verticalPosition(line: OcrLine, imageHeight: number): number {
  if (!imageHeight || imageHeight === 0) return 0.5;
  return Math.min(1, line.bbox.y0 / imageHeight);
}

/**
 * Pixel height of a line's bounding box — a proxy for font size.
 */
function lineHeight(line: OcrLine): number {
  return line.bbox.y1 - line.bbox.y0;
}

/** Average line height across all lines — used for relative comparison. */
function avgLineHeight(lines: OcrLine[]): number {
  if (lines.length === 0) return 0;
  return lines.reduce((sum, l) => sum + lineHeight(l), 0) / lines.length;
}

/** Filters words below a confidence threshold, rebuilds the line text. */
function rebuildLineFromHighConfWords(line: OcrLine, minConf: number): string {
  if (!line.words || line.words.length === 0) return line.text;
  const highConf = line.words.filter((w) => w.confidence >= minConf && w.text.trim().length > 0);
  return highConf.map((w) => w.text).join(" ").trim();
}

/**
 * Compute a name-candidate score (higher = more likely to be a person name).
 * Uses positional, font-size, and text-feature signals.
 */
function computeNameScore(
  text: string,
  line: OcrLine,
  imageHeight: number,
  avgHeight: number
): number {
  let score = 0;

  // Vertical position: top 50% gets a bonus
  const vPos = verticalPosition(line, imageHeight);
  if (vPos < 0.5) score += 0.35;
  else if (vPos < 0.7) score += 0.1;

  // Font size: larger than average gets a bonus
  const lh = lineHeight(line);
  if (avgHeight > 0 && lh > avgHeight * 1.15) score += 0.25;
  else if (avgHeight > 0 && lh > avgHeight * 0.9) score += 0.05;

  // Title case check
  const words = text.trim().split(/\s+/);
  const isTitleCase = words.length > 0 && words.every((w) => /^[A-Z]/.test(w));
  if (isTitleCase) score += 0.2;

  // Word count: 2-3 words is ideal for a name
  if (words.length === 2 || words.length === 3) score += 0.15;
  else if (words.length === 1) score += 0.05;
  else if (words.length > 4) score -= 0.2;

  // Penalise digits
  if (/\d/.test(text)) score -= 0.5;

  // Penalise noise
  score -= lineNoiseScore(text) * 0.8;

  // Penalise designation/company keywords
  if (containsKeyword(text, DESIGNATION_KEYWORDS)) score -= 0.6;
  if (containsKeyword(text, COMPANY_KEYWORDS)) score -= 0.4;

  return score;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Tier 2 extractor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tier 2 — Advanced Local Offline Structural NLP Engine.
 *
 * Accepts either:
 *  - `OcrRichResult` (bbox-aware, from runOcrRich) — full positional scoring
 *  - Plain `string` (fallback when rich data is unavailable)
 *
 * Key improvements:
 * - Word-level confidence filtering (drops OCR hallucinations from logos)
 * - Font-size proxy (bbox height) for name prominence scoring
 * - Vertical-position scoring (top-half bias for name)
 * - Designation keyword windowing (strips flanking OCR garbage)
 * - Company min-length guard + noise-checked lookback
 * - Address populated only with real address-bearing lines; OCR garbage discarded
 */
export function extractCardFieldsLocalNlp(
  input: string | OcrRichResult
): CardFields {
  const fields = emptyFields();

  // ── Normalise input ───────────────────────────────────────────────────────
  let rawText: string;
  let richLines: OcrLine[] = [];
  let imageHeight = 0;

  if (typeof input === "string") {
    rawText = input;
  } else {
    rawText = input.text;
    richLines = input.lines ?? [];
    imageHeight = input.imageHeight ?? 0;
  }

  if (!rawText || rawText.trim().length < 5) return fields;

  // ── Build a working set of annotated lines ────────────────────────────────
  // We pair each text line with its OcrLine metadata if available.
  // Strategy: split rawText by newline, then try to match each text line
  // to the nearest rich line by text similarity.

  interface WorkLine {
    rawText: string;    // original OCR text for this line
    cleanText: string;  // fully sanitised text
    ocrLine: OcrLine | null;
  }

  const rawSplitLines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // Build a rich-line lookup by clean text prefix (first 15 chars)
  const richLineMap = new Map<string, OcrLine>();
  for (const rl of richLines) {
    const key = rl.text.trim().slice(0, 15).toLowerCase();
    if (key) richLineMap.set(key, rl);
  }

  const workLines: WorkLine[] = rawSplitLines.map((raw) => {
    const key = raw.slice(0, 15).toLowerCase();
    const ocrLine = richLineMap.get(key) ?? null;
    // If we have rich data, rebuild line text using only high-confidence words
    const highConfText = ocrLine
      ? rebuildLineFromHighConfWords(ocrLine, 40)
      : raw;
    const cleanText = cleanLine(highConfText || raw);
    return { rawText: raw, cleanText, ocrLine };
  });

  const avgHeight = avgLineHeight(richLines);

  // ── Filter obvious noise and noise-line banners ───────────────────────────
  const validLines = workLines.filter((wl) => {
    if (!wl.cleanText || wl.cleanText.length < 2) return false;
    if (NOISE_LINE_RE.test(wl.cleanText)) return false;
    if (lineNoiseScore(wl.rawText) > 0.6) return false;
    return true;
  });

  // ── Phase 1: Extract deterministic fields ─────────────────────────────────
  let email = "";
  const phoneList: string[] = [];
  let website = "";

  const classifyLines: Array<WorkLine & { leftover: string }> = [];

  for (const wl of validLines) {
    let working = wl.cleanText;

    // Email
    if (!email) {
      const m = working.match(EMAIL_RE);
      if (m) {
        email = fixEmailTypos(m[0]);
        working = working.replace(m[0], " ").trim();
      }
    }

    // Phone
    const phoneMatches = working.match(PHONE_RE);
    if (phoneMatches) {
      for (const p of phoneMatches) {
        const dc = digitCount(p);
        if (dc >= 7 && dc <= 15 && !/^\+?\d{5,6}$/.test(p.trim())) {
          phoneList.push(p.trim());
          working = working.replace(p, " ").trim();
        }
      }
    }

    // Website
    if (!website) {
      const m = working.match(WEBSITE_RE);
      if (m && !m[0].includes("@")) {
        website = m[0].replace(/\/$/, "");
        working = working.replace(m[0], " ").trim();
      }
    }

    const leftover = working.replace(LABEL_PREFIX_RE, "").replace(/^\s*[:\-]\s*/, "").trim();
    if (leftover && leftover.length >= 2) {
      classifyLines.push({ ...wl, leftover });
    }
  }

  // ── Phase 2: Structural classification ───────────────────────────────────
  let designation = "";
  let designationLineIdx = -1;
  let company = "";
  const addressLines: string[] = [];
  const unclassified: Array<{ text: string; wl: WorkLine; idx: number }> = [];

  for (let i = 0; i < classifyLines.length; i++) {
    const { leftover } = classifyLines[i];
    const noise = lineNoiseScore(leftover);

    if (noise > 0.55) continue; // discard high-noise lines

    if (!designation && containsKeyword(leftover, DESIGNATION_KEYWORDS)) {
      designation = extractDesignationFromDirtyLine(leftover);
      designationLineIdx = i;
      continue;
    }

    if (!company && containsKeyword(leftover, COMPANY_KEYWORDS)) {
      const alphaOnly = leftover.replace(/[^a-zA-Z\s]/g, "").trim();
      if (alphaOnly.length < 3) continue; // reject garbage

      let fullCompany = leftover;
      // Lookback: use most recent unclassified line as brand prefix
      if (unclassified.length > 0) {
        const prev = unclassified[unclassified.length - 1];
        const prevNoise = lineNoiseScore(prev.text);
        if (
          prev.text.length >= 2 &&
          prev.text.length <= 50 &&
          prevNoise < 0.3 &&
          !containsKeyword(prev.text, DESIGNATION_KEYWORDS) &&
          !ADDRESS_HINT_RE.test(prev.text) &&
          !POSTAL_CODE_RE.test(prev.text)
        ) {
          fullCompany = `${prev.text} ${leftover}`;
          unclassified.pop();
        }
      }
      company = fullCompany;
      continue;
    }

    if (ADDRESS_HINT_RE.test(leftover) || POSTAL_CODE_RE.test(leftover)) {
      const alphaRatio = (leftover.match(/[a-zA-Z]/g) || []).length / leftover.length;
      if (alphaRatio > 0.2 || POSTAL_CODE_RE.test(leftover)) {
        addressLines.push(leftover);
      }
      continue;
    }

    // Gather as unclassified with rich metadata for name scoring
    unclassified.push({
      text: leftover,
      wl: classifyLines[i],
      idx: i,
    });
  }

  // ── Phase 3: Name detection using positional + font-size scoring ──────────
  let candidateName = "";
  let nameUnclassifiedIdx = -1;

  // Priority A: check lines adjacent to designation (±1 line in classifyLines)
  if (designationLineIdx >= 0) {
    for (const uc of unclassified) {
      if (
        uc.idx === designationLineIdx - 1 ||
        uc.idx === designationLineIdx + 1
      ) {
        const stripped = stripLeadingArtifacts(uc.text);
        const score = computeNameScore(
          stripped,
          uc.wl.ocrLine ?? ({ bbox: { x0: 0, y0: 0, x1: 0, y1: 0 } } as OcrLine),
          imageHeight,
          avgHeight
        );
        if (score > 0.3) {
          candidateName = stripped;
          nameUnclassifiedIdx = unclassified.indexOf(uc);
          break;
        }
      }
    }
  }

  // Priority B: score all unclassified, pick highest scorer
  if (!candidateName) {
    let bestScore = -Infinity;
    let bestIdx = -1;

    for (let i = 0; i < unclassified.length; i++) {
      const uc = unclassified[i];
      const stripped = stripLeadingArtifacts(uc.text);
      if (!stripped || stripped.length < 3) continue;

      const score = computeNameScore(
        stripped,
        uc.wl.ocrLine ?? ({ bbox: { x0: 0, y0: 0, x1: 0, y1: 0 } } as OcrLine),
        imageHeight,
        avgHeight
      );

      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestScore > 0.1) {
      candidateName = stripLeadingArtifacts(unclassified[bestIdx].text);
      nameUnclassifiedIdx = bestIdx;
    }
  }

  // Priority C: fallback to first plausible unclassified line
  if (!candidateName && unclassified.length > 0) {
    const stripped = stripLeadingArtifacts(unclassified[0].text);
    if (stripped.length >= 3 && lineNoiseScore(stripped) < 0.45) {
      candidateName = stripped;
      nameUnclassifiedIdx = 0;
    }
  }

  // ── Phase 4: Secondary company if keyword-based search failed ─────────────
  if (!company) {
    const compCandidate = unclassified.find(
      (uc, i) =>
        i !== nameUnclassifiedIdx &&
        uc.text.length >= 4 &&
        lineNoiseScore(uc.text) < 0.4 &&
        !ADDRESS_HINT_RE.test(uc.text)
    );
    if (compCandidate) company = compCandidate.text;
  }

  // ── Phase 5: Remaining unclassified → address ONLY if real address content ─
  for (let i = 0; i < unclassified.length; i++) {
    if (i === nameUnclassifiedIdx) continue;
    const { text } = unclassified[i];
    if (text === company || text === designation) continue;
    if (ADDRESS_HINT_RE.test(text) || POSTAL_CODE_RE.test(text)) {
      if (!addressLines.includes(text)) addressLines.push(text);
    }
    // Silently discard OCR garbage — never dump into address
  }

  // ── Assign fields ─────────────────────────────────────────────────────────
  fields.Name = candidateName;
  fields.Company = company;
  fields.Designation = designation;
  fields.Phone = phoneList.join(" / ");
  fields.Email = email;
  fields.Website = website;
  fields.Address = addressLines.join(", ");

  return fields;
}
