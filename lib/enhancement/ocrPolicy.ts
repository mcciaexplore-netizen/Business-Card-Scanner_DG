export const OCR_CONFIDENCE_THRESHOLD = 70;
export const MIN_OCR_TEXT_LENGTH = 15;

export interface OcrCandidate {
  engine: "tesseract" | "rapidocr";
  text: string;
  confidence: number;
}

/**
 * Local OCR output is accepted for deterministic parsing only when both the
 * engine confidence and the amount of recognized text are meaningful.
 */
export function isOcrCandidateUsable(candidate: OcrCandidate): boolean {
  return (
    Number.isFinite(candidate.confidence) &&
    candidate.confidence >= OCR_CONFIDENCE_THRESHOLD &&
    candidate.text.trim().length >= MIN_OCR_TEXT_LENGTH
  );
}

/** Selects the strongest OCR text to send to the cheaper Gemini text parser. */
export function selectBestOcrCandidate(candidates: OcrCandidate[]): OcrCandidate | null {
  return (
    [...candidates]
      .filter((candidate) => candidate.text.trim().length >= MIN_OCR_TEXT_LENGTH)
      .sort(
        (a, b) =>
          b.confidence - a.confidence ||
          b.text.trim().length - a.text.trim().length
      )[0] ?? null
  );
}
