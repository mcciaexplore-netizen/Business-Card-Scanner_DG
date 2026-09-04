import { CardFields, emptyFields } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic field regexes
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL_RE =
  /[a-zA-Z0-9][a-zA-Z0-9._%+\-]*@[a-zA-Z0-9\-]+(?:\.[a-zA-Z0-9\-]+)*\.[a-zA-Z]{2,}/i;

// Matches phone numbers with 7-15 digits; requires at least one digit cluster
const PHONE_RE =
  /(\+?[\d][\d\s\(\)\-\.]{4,}[\d])/g;

const WEBSITE_RE =
  /((?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9\-]+\.(?:com|in|co|org|net|io|ai|tech|app|me|info|biz|co\.in|net\.in|edu|gov|org\.in|us|uk|ca|de|fr)(?:\/[^\s]*)?)/i;

// Common label prefixes that OCR often places before field values
const LABEL_PREFIX_RE =
  /^(phone|mobile|mob|tel|telephone|fax|cell|email|e-mail|web|website|url|address|add|addr)\s*[:\-]?\s*/i;

// ─────────────────────────────────────────────────────────────────────────────
// Designation & company keyword lists
// ─────────────────────────────────────────────────────────────────────────────

const DESIGNATION_KEYWORDS = [
  // C-Suite
  "ceo", "cto", "cfo", "coo", "cmo", "cio", "chro", "cro", "cpo",
  "chief executive officer", "chief technology officer", "chief financial officer",
  "chief operating officer", "chief marketing officer",
  // Founders & Board
  "founder", "co-founder", "cofounder", "president", "vice president", "vp",
  "svp", "evp", "avp", "executive vice president", "senior vice president",
  "assistant vice president", "director", "managing director", "executive director",
  "non-executive director", "chairman", "chairperson", "chairwoman",
  // Partners & Owners
  "partner", "senior partner", "managing partner", "proprietor",
  "owner", "co-owner", "principal", "head of", "country head", "global head",
  // Management
  "general manager", "gm", "manager", "senior manager", "sr. manager",
  "assistant manager", "asst. manager", "deputy manager", "branch manager",
  "regional manager", "area manager", "project manager", "product manager",
  "program manager", "operations manager", "sales manager", "marketing manager",
  "business development manager", "bdm", "account manager",
  // Technical
  "architect", "solutions architect", "software engineer", "senior software engineer",
  "sr. software engineer", "sr. engineer", "lead engineer", "principal engineer",
  "staff engineer", "engineer", "data scientist", "devops engineer",
  "system administrator", "sysadmin", "qa manager", "ui/ux designer",
  "tech lead", "team lead", "lead", "developer", "designer",
  // Administrative
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

// ─────────────────────────────────────────────────────────────────────────────
// Noise detection helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Characters that are definitively OCR noise (not printable ASCII letters/digits). */
const NOISE_CHAR_RE = /[^a-zA-Z0-9\s@.\-+()\/&,']/g;

/**
 * Lines that are clearly section headers or noise banners on business cards,
 * not real data fields.
 */
const NOISE_LINE_RE =
  /^(services|products|our\s+services|branch\s+office|head\s+office|iso\s*\d+|contact\s+us|visit\s+us|company\s+profile|business\s+card|phone|email|website|address|www\.)$/i;

/**
 * Returns a 0-1 "noise score" for a raw OCR line.
 * Score > 0.5 means the line is predominantly garbage.
 */
function lineNoiseScore(line: string): number {
  if (!line || line.length === 0) return 1;
  const nonAlphaNum = (line.match(/[^a-zA-Z0-9\s]/g) || []).length;
  const ratio = nonAlphaNum / line.length;
  // Penalise very short lines with any noise char heavily
  if (line.length <= 4 && ratio > 0) return 0.8;
  return ratio;
}

/**
 * Strips common Tesseract leading-artifact patterns from the start of a line:
 *   "0) Piyush Shah"  →  "Piyush Shah"
 *   "| Founder & CEO" →  "Founder & CEO"
 *   "5 N P Medical"  →  "N P Medical"
 */
function stripLeadingArtifacts(line: string): string {
  // Remove leading 1-3 chars that are non-alpha (digits, brackets, pipes, etc.)
  // followed by whitespace, as long as what follows starts with an alpha char
  return line.replace(/^[\s\W\d]{1,5}(?=[A-Za-z])/, "").trim();
}

/**
 * Strips trailing OCR noise tokens from a line.
 * e.g. "Founder & CEO iB" → "Founder & CEO"
 * A trailing noise token is a single uppercase letter or 1-2 char non-word.
 */
function stripTrailingArtifacts(line: string): string {
  // Remove trailing 1-2 all-uppercase or non-word tokens
  return line.replace(/\s+\b[A-Z]{1,2}\b\s*$/, "").trim();
}

/**
 * Full line sanitizer: strips leading/trailing artifacts and removes
 * known OCR noise characters (¥, ?, =, etc.) while preserving @ . - + ()
 */
function cleanOcrLine(line: string): string {
  let clean = line
    .replace(/[•·|~*°»«©®™℠]+/g, " ")          // remove known decoration chars
    .replace(NOISE_CHAR_RE, " ")                  // remove truly unreadable chars
    .replace(/\s{2,}/g, " ")                      // collapse multiple spaces
    .trim();
  clean = stripLeadingArtifacts(clean);
  clean = stripTrailingArtifacts(clean);
  return clean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Keyword matching helpers
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

// ─────────────────────────────────────────────────────────────────────────────
// Name validation
// ─────────────────────────────────────────────────────────────────────────────

const NON_NAME_PATTERNS = [
  /business\s*card/i,
  /\bservices\b/i,
  /\bproducts\b/i,
  /branch\s*office/i,
  /head\s*office/i,
  /contact\s*us/i,
  /\biso\s*\d+/i,
  /visit\s*us/i,
  /our\s*services/i,
  /company\s*profile/i,
  /\baddress\b/i,
  /\b(mobile|phone|email|website|www\.)/i,
  /\bpvt\b|\bltd\b|\bllp\b|\binc\b|\bcorp\b/i,
];

/**
 * Decides whether a cleaned line is plausibly a person's name.
 * Rules (all must pass):
 * 1. Length 3–50
 * 2. Does not start with a digit or symbol
 * 3. No long number sequences (≥4 consecutive digits)
 * 4. Not matching known non-name banners
 * 5. Noise score < 0.4
 * 6. Words: 1–4
 * 7. Each word starts with a capital letter (TitleCase / ALLCAPS OK)
 * 8. Does not contain designation or company keywords
 */
function isLikelyName(line: string): boolean {
  if (!line || line.length < 3 || line.length > 50) return false;
  if (/^[\d\W]/.test(line)) return false;              // starts with digit/symbol
  if (/\d{4,}/.test(line)) return false;               // long number in text
  if (NON_NAME_PATTERNS.some((p) => p.test(line))) return false;
  if (lineNoiseScore(line) > 0.4) return false;

  const words = line.trim().split(/\s+/);
  if (words.length < 1 || words.length > 4) return false;

  // Each word must start with a capital (allows "Dr.", "Jr.", initials)
  const titleCase = words.every((w) => /^[A-Z]/.test(w));
  if (!titleCase) return false;

  // Must not be a designation or company keyword line
  if (containsKeyword(line, DESIGNATION_KEYWORDS)) return false;
  if (containsKeyword(line, COMPANY_KEYWORDS)) return false;

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Designation line extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given a dirty line like "C Ake Pa Founder & CEO iB",
 * finds the first designation keyword in the line and extracts
 * a clean window around it (up to 4 words before + all following known title words).
 */
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

  // Take the substring from bestIdx, then strip trailing noise tokens
  const extracted = line.substring(bestIdx).trim();
  return stripTrailingArtifacts(extracted);
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedCard {
  fields: CardFields;
  missingRequired: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Tier 1 parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tier 1 — Fast Local Regex + Heuristic Parser.
 *
 * Improvements over previous version:
 * - Pre-cleaning layer strips OCR noise chars and leading/trailing artifacts
 * - Per-line noise scoring discards garbage lines before classification
 * - Designation lines cleaned via keyword-windowing (removes flanking OCR junk)
 * - Company min-length guard (rejects single-char garbage)
 * - Name validation rejects leading-digit/symbol patterns like "0) Piyush"
 * - Address only populated with lines containing real address indicators;
 *   pure-noise lines are discarded rather than dumped into address
 */
export function parseCardText(rawText: string): ParsedCard {
  const fields = emptyFields();

  // ── Step 0: Global OCR pre-cleaning ──────────────────────────────────────
  const preCleaned = rawText
    .replace(/\r\n/g, "\n")
    .replace(/(\w+)\s*@\s*(\w)/g, "$1@$2")      // fix spaces around @
    .replace(/(www|https?)\s*\.\s*/gi, "$1.");   // fix spaced URLs

  const rawLines = preCleaned
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  // ── Step 1: Clean each line and pre-filter obvious noise ─────────────────
  const cleanedLines: string[] = [];
  for (const raw of rawLines) {
    const cleaned = cleanOcrLine(raw);
    if (!cleaned || cleaned.length < 2) continue;
    if (NOISE_LINE_RE.test(cleaned)) continue;
    // Discard lines that are >60% noise characters (logo artifacts, etc.)
    if (lineNoiseScore(raw) > 0.6) continue;
    cleanedLines.push(cleaned);
  }

  // ── Step 2: Extract deterministic fields (Email, Phone, Website) ─────────
  let email = "";
  const phoneParts: string[] = [];
  let website = "";
  const remainingLines: string[] = [];

  for (const line of cleanedLines) {
    let working = line;

    // Email
    if (!email) {
      const m = working.match(EMAIL_RE);
      if (m) {
        email = m[0].toLowerCase().replace(/\s+/g, "");
        working = working.replace(m[0], " ").trim();
      }
    }

    // Phone
    const phoneMatches = working.match(PHONE_RE);
    if (phoneMatches) {
      for (const m of phoneMatches) {
        const digits = digitCount(m);
        if (digits >= 7 && digits <= 15) {
          // Avoid capturing lone zip codes as phones
          if (!/^\+?\d{5,6}$/.test(m.trim())) {
            phoneParts.push(m.trim());
            working = working.replace(m, " ").trim();
          }
        }
      }
    }

    // Website (only if different from email domain)
    if (!website) {
      const m = working.match(WEBSITE_RE);
      if (m && !m[0].includes("@")) {
        website = m[0].replace(/\/$/, "");
        working = working.replace(m[0], " ").trim();
      }
    }

    // Remove label prefixes and keep the remainder
    const leftover = working
      .replace(LABEL_PREFIX_RE, "")
      .replace(/^\s*[:\-]\s*/, "")
      .trim();
    if (leftover && leftover.length >= 2) {
      remainingLines.push(leftover);
    }
  }

  // ── Step 3: Classify remaining lines ─────────────────────────────────────
  let designation = "";
  let company = "";
  const addressParts: string[] = [];
  const unclassified: string[] = [];

  for (let i = 0; i < remainingLines.length; i++) {
    const line = remainingLines[i];
    const noise = lineNoiseScore(line);

    // Skip very noisy leftover lines entirely
    if (noise > 0.55) continue;

    if (!designation && containsKeyword(line, DESIGNATION_KEYWORDS)) {
      // Clean the designation line of flanking OCR artifacts
      designation = extractDesignationFromDirtyLine(line);
      continue;
    }

    if (!company && containsKeyword(line, COMPANY_KEYWORDS)) {
      // Reject obviously garbage company candidates
      const alphaOnly = line.replace(/[^a-zA-Z\s]/g, "").trim();
      if (alphaOnly.length < 3) continue;

      let fullCompany = line;
      // Lookback: prepend previous unclassified line only if it looks like
      // a real brand prefix (alphabetic, no noise, not a designation)
      if (unclassified.length > 0) {
        const prev = unclassified[unclassified.length - 1];
        const prevNoise = lineNoiseScore(prev);
        if (
          prev.length >= 2 &&
          prev.length <= 50 &&
          prevNoise < 0.3 &&
          !containsKeyword(prev, DESIGNATION_KEYWORDS) &&
          !ADDRESS_HINT_RE.test(prev) &&
          !POSTAL_CODE_RE.test(prev)
        ) {
          fullCompany = `${prev} ${line}`;
          // Remove prev from unclassified since it's now part of company
          unclassified.pop();
        }
      }
      company = fullCompany;
      continue;
    }

    if (ADDRESS_HINT_RE.test(line) || POSTAL_CODE_RE.test(line)) {
      // Only push if the line has some alpha content (not pure numbers/garbage)
      const alphaRatio = (line.match(/[a-zA-Z]/g) || []).length / line.length;
      if (alphaRatio > 0.2 || POSTAL_CODE_RE.test(line)) {
        addressParts.push(line);
      }
      continue;
    }

    unclassified.push(line);
  }

  // ── Step 4: Pick name from unclassified ──────────────────────────────────
  let name = "";
  let nameIndex = -1;

  for (let i = 0; i < unclassified.length; i++) {
    const candidate = stripLeadingArtifacts(unclassified[i]);
    if (isLikelyName(candidate)) {
      name = candidate;
      nameIndex = i;
      break;
    }
  }

  // Fallback: if no clean name found, take first unclassified and strip artifacts
  if (!name && unclassified.length > 0) {
    const stripped = stripLeadingArtifacts(unclassified[0]);
    // Accept only if it passes minimal checks (not pure garbage)
    if (stripped.length >= 3 && lineNoiseScore(stripped) < 0.4) {
      name = stripped;
      nameIndex = 0;
    }
  }

  // ── Step 5: Secondary company detection from unclassified ─────────────────
  if (!company) {
    const compCandidate = unclassified.find(
      (l, idx) =>
        idx !== nameIndex &&
        !ADDRESS_HINT_RE.test(l) &&
        l.length >= 4 &&
        lineNoiseScore(l) < 0.4
    );
    if (compCandidate) company = compCandidate;
  }

  // ── Step 6: Remaining unclassified → address ONLY if real address content ─
  for (let i = 0; i < unclassified.length; i++) {
    if (i === nameIndex) continue;
    if (unclassified[i] === company) continue;
    if (unclassified[i] === designation) continue;

    const l = unclassified[i];
    // Only include in address if it has address hints or postal code;
    // discard everything else (it's OCR garbage, not an address)
    if (ADDRESS_HINT_RE.test(l) || POSTAL_CODE_RE.test(l)) {
      if (!addressParts.includes(l)) addressParts.push(l);
    }
    // Silently discard pure OCR garbage — do NOT dump into address
  }

  // ── Assign fields ─────────────────────────────────────────────────────────
  fields.Name = name;
  fields.Company = company;
  fields.Designation = designation;
  fields.Phone = phoneParts.join(" / ");
  fields.Email = email;
  fields.Website = website;
  fields.Address = addressParts.join(", ");

  const missingRequired =
    cleanedLines.length === 0 ||
    !fields.Name ||
    (!fields.Phone && !fields.Email);

  return { fields, missingRequired };
}
