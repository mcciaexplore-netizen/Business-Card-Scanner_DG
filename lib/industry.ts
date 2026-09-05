import type { CardFields } from "./types";

type IndustryRule = {
  industry: string;
  pattern: RegExp;
};

const INDUSTRY_RULES: IndustryRule[] = [
  {
    industry: "Government, Diplomacy & Economic Development",
    pattern: /\b(embassy|ubalozi|business france|helsinki partners|development corporation|institution for transformation|government|ministry|authority)\b/i,
  },
  {
    industry: "Export Credit Insurance",
    pattern: /\b(ecgc|export credit guarantee)\b/i,
  },
  {
    industry: "Banking & Financial Services",
    pattern: /\b(bank|banking|finserv|finance|financial|capital|receivables exchange|rxil|nasdaq|bny|carlyle|pfrda|pension fund|sidbi)\b/i,
  },
  {
    industry: "Aerospace, Drones & Propulsion",
    pattern: /\b(aerospace|rocket|propulsion|thrustworks|dynetics|volar alta|drone inspection)\b/i,
  },
  {
    industry: "Automotive & Mobility",
    pattern: /\b(automotive|autocomp|opmobility|gedia|yazaki|nexteer|renault|neuton|vehicle|ev division)\b/i,
  },
  {
    industry: "Biotechnology & Life Sciences",
    pattern: /\b(bioscience|biotech|biotechnology|life sciences|medical devices|diagnostics|pharma)\b/i,
  },
  {
    industry: "Environment, Energy & Circular Economy",
    pattern: /\b(sustainab|bioenergy|recycl|e-?waste|waste management|circular economy|ecotantra|ecomantra|enggauge|sorting swans|stenum|renewable energy|esg)\b/i,
  },
  {
    industry: "Education, Training & Skill Development",
    pattern: /\b(education|school|institute|university|academy|skill|eduplus|kalonedu|enlit kids|fuel for nation|stemium|learning|training)\b/i,
  },
  {
    industry: "Logistics, Ports & Aviation",
    pattern: /\b(logistics|air\s*&\s*sea|airport|port of|dp world|dsv|freight|shipping|supply chain)\b/i,
  },
  {
    industry: "Agriculture & Food Trade",
    pattern: /\b(agro|agri|agriculture|goldstone ag|fruit|vegetable exports|food exports)\b/i,
  },
  {
    industry: "IT, Software, Cloud & AI",
    pattern: /\b(software|analytics|cloud|cybersecurity|data platform|digital transformation|artificial intelligence|itechseed|leapswitch|left right mind|leftrightmind|nuagecx|orange oranges|users software|eyeshiv|proserrio)\b/i,
  },
  {
    industry: "Professional & Business Services",
    pattern: /\b(consult|advisory|kpmg|pwc|pricewaterhouse|antal|goldratt|accountant|chartered accountant|communications|recruitment|business services)\b/i,
  },
  {
    industry: "Industrial Engineering & Manufacturing",
    pattern: /\b(manufactur\w*|machines?|valves?|boilers?|electrodes?|steel|packaging|mould|mold|shims?|thermax|aquatech|forbes marshall|geomet|autocomp|precision|fabrication|process equipment|genset|diecasting)\b/i,
  },
  {
    industry: "Trade, Import & Export",
    pattern: /\b(trading|traders|exim|exports?|imports?)\b/i,
  },
  {
    industry: "Industry Association & Nonprofit",
    pattern: /\b(council|forum|society|foundation|nonprofit|non-profit|industries club)\b/i,
  },
];

/**
 * Uses company/business evidence, never the contact's job title on its own.
 * Product/service descriptions take priority over a generic company name.
 */
export function detectIndustry(
  fields: Pick<CardFields, "Company" | "Website" | "Email" | "Designation"> & Partial<Pick<CardFields, "Name" | "Address">>,
  cardText = ""
): string {
  const description = cardText.split(/\r?\n/).filter((line) => {
    const text = line.trim().toLowerCase();
    return text && ![fields.Name, fields.Company, fields.Designation, fields.Address].some(
      (value) => value?.trim().toLowerCase() === text
    ) && !/[@\d]|https?:|www\./i.test(text);
  }).join(" ");
  const evidence = [
    description,
    fields.Company,
    fields.Website,
    fields.Email.split("@").slice(1).join(" "),
  ];
  for (const text of evidence) {
    const searchable = text.replace(/[_/.-]+/g, " ").replace(/\s+/g, " ").trim();
    for (const rule of INDUSTRY_RULES) {
      if (rule.pattern.test(searchable)) return rule.industry;
    }
  }

  return "Unclassified";
}

export function withDetectedIndustry(fields: CardFields): CardFields {
  const extractedIndustry = fields.Industry?.trim();
  if (isClassifiedIndustry(extractedIndustry)) {
    return { ...fields, Industry: extractedIndustry, "Industry Source": fields["Industry Source"] || "Card text" };
  }

  const industry = detectIndustry(fields);
  return { ...fields, Industry: industry, "Industry Source": isClassifiedIndustry(industry) ? "Card text (offline rules)" : "Unresolved" };
}

export function isClassifiedIndustry(value: string | undefined): value is string {
  return Boolean(value?.trim() && !/^(unknown|n\/?a|none|null|other|unclassified|not specified)$/i.test(value.trim()));
}

export interface IndustryLookup {
  industry: string;
  sources: string[];
  searchHtml?: string;
}

export type IndustrySearch = (company: string, website: string, timeoutMs: number) => Promise<IndustryLookup | null>;

/** Optional enrichment must never turn an extracted card into a failed scan. */
export async function enrichIndustry(
  fields: CardFields,
  search: IndustrySearch,
  timeoutMs = 10000
): Promise<CardFields> {
  const classified = withDetectedIndustry(fields);
  if (isClassifiedIndustry(classified.Industry)) return classified;
  if (!fields.Company.trim() || timeoutMs < 1000) {
    return { ...classified, "Industry Source": fields.Company.trim() ? "Unresolved (search time budget exhausted)" : "Unresolved (company missing)" };
  }
  try {
    const result = await search(fields.Company, fields.Website, timeoutMs);
    if (result && isClassifiedIndustry(result.industry) && result.sources.length) {
      return {
        ...classified,
        Industry: result.industry,
        "Industry Source": "Web search (Google Search via Gemini)",
        "Industry Sources": result.sources.join("\n"),
        industrySearchHtml: result.searchHtml,
      };
    }
    return { ...classified, "Industry Source": "Unresolved (no verified web match)" };
  } catch {
    return { ...classified, "Industry Source": "Unresolved (web search unavailable)" };
  }
}

interface SearchGrounding {
  groundingChunks?: { web?: { uri?: string } }[];
  groundingSupports?: { segment?: { text?: string }; groundingChunkIndices?: number[] }[];
  searchEntryPoint?: { renderedContent?: string };
  webSearchQueries?: string[];
}

/** Accept only a matched company and a sector backed by provider citations. */
export function parseIndustryLookup(text: string, grounding?: SearchGrounding): IndustryLookup | null {
  const json = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let data: { industry?: unknown; companyMatched?: unknown };
  try {
    data = JSON.parse(json);
  } catch {
    // Grounding often omits claim citations for JSON/code-block responses.
    // Plain prose preserves provider grounding while the labels stay parseable.
    const plain = text.replace(/\*\*/g, "");
    const matched = plain.match(/^Company matched:\s*(yes|no)\s*$/im);
    const sector = plain.match(/^Industry:\s*([^\r\n]+)/im);
    if (!matched || !sector) return null;
    data = { companyMatched: matched[1].toLowerCase() === "yes", industry: sector[1].replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "").trim() };
  }
  if (!data || data.companyMatched !== true || typeof data.industry !== "string" ||
      data.industry.length > 160 || !isClassifiedIndustry(data.industry) || !grounding?.webSearchQueries?.length) return null;
  const industry = data.industry.trim();
  const indices = (grounding.groundingSupports || []).filter(
    (support) => support.segment?.text?.toLowerCase().includes(industry.toLowerCase())
  ).flatMap((support) => support.groundingChunkIndices || []);
  const sources = [...new Set(indices.map((index) => grounding.groundingChunks?.[index]?.web?.uri).filter(
    (uri): uri is string => {
      if (!uri) return false;
      try { const url = new URL(uri); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
    }
  ))];
  if (!sources.length) return null;
  return { industry, sources, searchHtml: grounding.searchEntryPoint?.renderedContent };
}
