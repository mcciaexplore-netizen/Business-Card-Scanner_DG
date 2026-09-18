import { promises as dns } from "node:dns";
import type { CardFields } from "./types";

const EMAIL_PATTERN = /[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
const DOMAIN_PATTERN = /(?:https?:\/\/)?(?:www\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)/gi;
const DNS_TIMEOUT_MS = 1500;

function compactPrintedText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s*([@.])\s*/g, "$1")
    .replace(/\s+/g, " ");
}

export function normalizeContactDomain(value: string): string {
  const compact = compactPrintedText(value.trim())
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#\s]/)[0]
    .replace(/[.,;:]+$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(compact)
    ? compact
    : "";
}

function printedEmails(evidence: string): Set<string> {
  return new Set((compactPrintedText(evidence).match(EMAIL_PATTERN) || []).map((value) => value.toLocaleLowerCase()));
}

function printedWebsiteDomains(evidence: string): Set<string> {
  // An email domain is not proof that a website was printed on the card.
  const withoutEmails = compactPrintedText(evidence).replace(EMAIL_PATTERN, " ");
  const domains = new Set<string>();
  for (const match of withoutEmails.matchAll(DOMAIN_PATTERN)) {
    const domain = normalizeContactDomain(match[1] || match[0]);
    if (domain) domains.add(domain);
  }
  return domains;
}

/** Keeps model contacts only when the supplied printed evidence contains them. */
export function validateContactsAgainstEvidence(
  fields: CardFields,
  emailEvidence: string,
  websiteEvidence: string
): CardFields {
  const email = compactPrintedText(fields.Email).replace(/\s/g, "");
  const websiteDomain = normalizeContactDomain(fields.Website);
  return {
    ...fields,
    Email: email && printedEmails(emailEvidence).has(email) ? fields.Email.trim() : "",
    Website: websiteDomain && printedWebsiteDomains(websiteEvidence).has(websiteDomain)
      ? fields.Website.trim()
      : "",
  };
}

type DomainResolution = boolean | null;
type DomainResolver = (domain: string) => Promise<DomainResolution>;
const dnsCache = new Map<string, Promise<DomainResolution>>();

async function resolvePublicDomain(domain: string): Promise<DomainResolution> {
  let cached = dnsCache.get(domain);
  if (!cached) {
    cached = Promise.race([
      dns.resolveAny(domain).then((records) => records.length > 0),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), DNS_TIMEOUT_MS)),
    ]).catch((error: NodeJS.ErrnoException) => {
      // Remove only definite negative DNS answers. Transient/network failures
      // must not erase legitimate data.
      return error.code === "ENOTFOUND" || error.code === "ENODATA" ? false : null;
    });
    dnsCache.set(domain, cached);
  }
  return cached;
}

/** Removes malformed contacts and domains that DNS definitively says do not exist. */
export async function removeNonexistentContacts(
  fields: CardFields,
  resolver: DomainResolver = resolvePublicDomain
): Promise<CardFields> {
  const email = fields.Email.trim();
  const emailMatch = email.match(new RegExp(`^${EMAIL_PATTERN.source}$`, "i"));
  const emailDomain = emailMatch ? normalizeContactDomain(email.split("@")[1]) : "";
  const websiteDomain = normalizeContactDomain(fields.Website);
  const domains = [...new Set([emailDomain, websiteDomain].filter(Boolean))];
  const results = new Map<string, DomainResolution>();
  await Promise.all(domains.map(async (domain) => results.set(domain, await resolver(domain))));

  return {
    ...fields,
    Email: emailDomain && results.get(emailDomain) !== false ? email : "",
    Website: websiteDomain && results.get(websiteDomain) !== false ? fields.Website.trim() : "",
  };
}
