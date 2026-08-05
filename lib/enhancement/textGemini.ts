import { getGeminiClient, GEMINI_MODEL } from "../geminiClient";
import { FIELD_NAMES, CardFields } from "../types";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(FIELD_NAMES.map((n) => [n, { type: "string" }])),
  required: [...FIELD_NAMES],
};

const TEXT_EXTRACTION_PROMPT = `You are an expert business card field parser. Analyze the following raw OCR text extracted from a business card and parse it into JSON contact fields according to the schema.

Field Identification & Correction Rules:
- "Name": Identify the primary contact person's full name. Ignore generic headings like "Services", "Products", "Branch Office", "Contact Us", "ISO Certified".
- "Email": Fix OCR typos in email addresses (e.g. spaces around "@", "gma1l" -> "gmail", "c0m" -> "com").
- "Website": Clean domain names (e.g., "www . example . com" -> "www.example.com").
- "Phone": Capture EVERY phone number printed in the text (mobile, office, direct line, fax). Preserve country codes (+91, +1), area codes, and original formatting. Separate multiple numbers with " / ".
- "Company": Detect company/organization name. Look for entity suffixes ("Pvt Ltd", "Limited", "Inc", "LLC", "Corp", "Group", "Technologies", "Solutions", "Services", "Industries", etc.) or brand titles.
- "Designation": Identify job titles across all levels (CEO, MD, Director, Manager, Lead, Engineer, Consultant, Executive, Architect, Founder, Partner, Level 1-3).
- "Address": Combine multi-line street address, building/floor/plot details, colony/nagar/sector/city/state/country, and 5-6 digit PIN/ZIP codes into a single line separated by commas.
- If a field is not present in the text, return an empty string "". Do not invent fake data.

RAW OCR TEXT:
`;

/**
 * Sends raw OCR text string (instead of image bytes) to Gemini Text API.
 * Costs ~150 input tokens ($0.000035 / ~0.003 INR) - 100x cheaper than vision calls.
 */
export async function extractFieldsFromOcrText(rawText: string): Promise<CardFields> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      { text: `${TEXT_EXTRACTION_PROMPT}\n"${rawText}"` },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const text = response.text ?? "";
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Could not parse Gemini Text API response: ${text}`);
  }

  const result = {} as CardFields;
  for (const name of FIELD_NAMES) {
    result[name] = String(data[name] ?? "").trim();
  }
  return result;
}
