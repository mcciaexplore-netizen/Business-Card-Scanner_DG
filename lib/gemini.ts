import { getGeminiClient, GEMINI_MODEL, detectMimeType } from "./geminiClient";
import { EXTRACTED_FIELD_NAMES, CardFields, emptyFields } from "./types";
import { validateContactsAgainstEvidence } from "./contactValidation";

const EVIDENCE_FIELD_NAMES = ["Email Evidence", "Website Evidence"] as const;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: Object.fromEntries([...EXTRACTED_FIELD_NAMES, ...EVIDENCE_FIELD_NAMES].map((n) => [n, { type: "string" }])),
  required: [...EXTRACTED_FIELD_NAMES, ...EVIDENCE_FIELD_NAMES],
};

const EXTRACTION_PROMPT = `You are reading a single business card image. Extract
the contact details and return them as JSON matching the given schema.

Rules:
- "Phone": capture EVERY phone number printed on the card - never drop
  any of them or pick just one, even if there are two, three, or more
  (e.g. mobile, office, direct line, fax listed as a phone).
  - Preserve parentheses exactly as printed - they're commonly used for
    area codes or country codes, e.g. "(555)", "+1 (555)", "(+91)". Do
    NOT strip, remove, or "clean up" anything inside parentheses.
  - Preserve the original formatting characters exactly as printed:
    dashes, spaces, plus signs, and parentheses. Don't reformat,
    simplify, or normalize the number.
  - If the card already separates multiple numbers with a slash ("/"),
    keep that formatting as-is. If they're separated some other way
    (new line, comma, "and", labeled "Mobile:"/"Office:", etc.), join
    them together with " / " between each, in the order printed.
  - Include every country code exactly as printed, whether it appears
    before the number (e.g. "+1 555-123-4567") or inside parentheses
    (e.g. "(+91) 98765 43210").
- "Email": return it only when a complete address containing "@" is visibly
  printed. Copy it exactly; never repair spelling or derive it from a website.
- "Website": return it only when a URL/domain with a visible dot is explicitly
  printed. Copy it exactly; never derive it from the company name or email.
- "Email Evidence": copy the exact visible line containing the email, or "".
- "Website Evidence": copy the exact visible line containing the website, or "".
- "Industry": return one concise, high-level business sector based on the
  company name, website/email domain, and any products or services printed on
  the card (for example "Banking & Financial Services" or "Automotive &
  Mobility"). A person's job title is not the company's sector. Generic names
  containing "Technologies", "Solutions", or "Ventures" are insufficient on
  their own. If the business evidence is insufficient, return "Unclassified";
  unresolved industries are researched separately after card extraction.
- "Address": combine a multi-line postal address into a single line,
  separated by commas.
- For contact fields not present on the card, uncertain, cut off, or unreadable,
  return an empty string "". Never complete, repair, guess, or invent contact
  data. Industry may only be inferred using the evidence described above.
- The card may be photographed at an angle, sideways, or upside down -
  read it correctly regardless of orientation.
`;

/**
 * Sends one business-card image to Gemini Vision and returns a dict of
 * mapped fields (Name, Company, Industry, Designation, Phone, Email,
 * Website, Address), ready to hand to storage.appendRow().
 */
export async function extractCardFields(imageBytes: Buffer): Promise<CardFields> {
  const ai = getGeminiClient();
  const mimeType = detectMimeType(imageBytes);

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      { inlineData: { mimeType, data: imageBytes.toString("base64") } },
      { text: EXTRACTION_PROMPT },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
    },
  });

  const text = response.text ?? "";
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Could not parse Gemini's response as JSON: ${text}`);
  }

  const result = emptyFields();
  for (const name of EXTRACTED_FIELD_NAMES) {
    result[name] = String(data[name] ?? "").trim();
  }
  return validateContactsAgainstEvidence(
    result,
    String(data["Email Evidence"] ?? ""),
    String(data["Website Evidence"] ?? "")
  );
}
