import type { CardFields } from "@/lib/types";

export function IndustryResearch({ fields }: { fields: CardFields }) {
  const sources = (fields["Industry Sources"] || "").split("\n").flatMap((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password ? [url] : [];
    } catch { return []; }
  });
  if (!sources.length) return <>—</>;
  return (
    <div className="industry-research">
      <ul>
        {sources.map((url, index) => (
          <li key={url.href}><a href={url.href} target="_blank" rel="noopener noreferrer">Source {index + 1}: {url.hostname}</a></li>
        ))}
      </ul>
      {fields.industrySearchHtml && (
        <iframe
          title="Google Search suggestions for the company industry"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src https: data:; base-uri \'none\'; form-action \'none\'">' + fields.industrySearchHtml}
        />
      )}
    </div>
  );
}
