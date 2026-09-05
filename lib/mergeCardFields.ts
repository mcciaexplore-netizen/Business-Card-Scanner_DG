import { CardFields } from "./types";
import { isClassifiedIndustry } from "./industry";

// ─────────────────────────────────────────────────────────────────────────────
// Phone deduplication helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Strips all non-digit chars for normalised comparison (e.g. "+91 98765-43210" → "919876543210"). */
function normalisePhone(p: string): string {
  return p.replace(/\D/g, "");
}

/**
 * Merges two Phone strings, deduplicating by normalised digit sequence.
 * Preserves the original formatting of whichever copy is kept.
 *
 * e.g.  "98765 43210 / 022-12345678"  +  "022-12345678"
 *  →   "98765 43210 / 022-12345678"   (dupe dropped)
 */
function mergePhones(front: string, back: string): string {
  const frontParts = front ? front.split(" / ").map((p) => p.trim()).filter(Boolean) : [];
  const backParts  = back  ? back.split(" / ").map((p) => p.trim()).filter(Boolean) : [];

  const seen = new Set(frontParts.map(normalisePhone));
  const merged = [...frontParts];

  for (const bp of backParts) {
    const normalised = normalisePhone(bp);
    if (normalised && !seen.has(normalised)) {
      seen.add(normalised);
      merged.push(bp);
    }
  }

  return merged.join(" / ");
}

function mergeExtractionEngines(front: string, back: string): string {
  if (!front) return back;
  if (!back || front === back) return front;
  return `Front: ${front}; Back: ${back}`;
}

/**
 * Merges two Address strings, deduplicating identical comma-separated parts
 * and concatenating the rest.
 */
function mergeAddresses(front: string, back: string): string {
  if (!front && !back) return "";
  if (!front) return back;
  if (!back)  return front;
  if (front.toLowerCase().trim() === back.toLowerCase().trim()) return front;

  const frontParts = front.split(",").map((p) => p.trim()).filter(Boolean);
  const backParts  = back.split(",").map((p) => p.trim()).filter(Boolean);
  const seen = new Set(frontParts.map((p) => p.toLowerCase()));

  const extra = backParts.filter((p) => !seen.has(p.toLowerCase()));
  return [...frontParts, ...extra].join(", ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Main merge function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Smart field-level merge of two sides of the same business card.
 *
 * Rules:
 * - Name / Designation: front preferred; fall back to back if front empty.
 * - Company / Industry / Email / Website: front preferred; fall back to back.
 * - Phone: concatenate both sides, deduplicated by normalised digit sequence.
 * - Address: concatenate both sides, deduplicated by comma-separated parts.
 */
export function mergeCardSides(front: CardFields, back: CardFields): CardFields {
  const industrySide = isClassifiedIndustry(front.Industry) ? front : back;
  return {
    ...front,
    Name:        front.Name        || back.Name,
    Company:     front.Company     || back.Company,
    Industry:    industrySide.Industry || "Unclassified",
    "Industry Source": industrySide["Industry Source"],
    "Industry Sources": industrySide["Industry Sources"],
    industrySearchHtml: industrySide.industrySearchHtml,
    Designation: front.Designation || back.Designation,
    Phone:       mergePhones(front.Phone, back.Phone),
    Email:       front.Email       || back.Email,
    Website:     front.Website     || back.Website,
    Address:     mergeAddresses(front.Address, back.Address),
    "Extraction Engine": mergeExtractionEngines(
      front["Extraction Engine"],
      back["Extraction Engine"]
    ),
  };
}
