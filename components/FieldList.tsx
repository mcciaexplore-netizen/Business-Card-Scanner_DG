"use client";

import { Fragment } from "react";
import { FIELD_NAMES, CardFields } from "@/lib/types";
import { IndustryResearch } from "./IndustryResearch";

export function FieldList({ fields }: { fields: CardFields }) {
  return (
    <dl className="field-list">
      {FIELD_NAMES.map((key) => (
        <Fragment key={key}>
          <dt>{key}</dt>
          <dd>{key === "Industry Sources" ? <IndustryResearch fields={fields} /> : fields[key]?.trim() ? fields[key] : "—"}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
