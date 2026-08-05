"use client";

import { Fragment } from "react";
import { FIELD_NAMES, CardFields } from "@/lib/types";

export function FieldList({ fields }: { fields: CardFields }) {
  return (
    <dl className="field-list">
      {FIELD_NAMES.map((key) => (
        <Fragment key={key}>
          <dt>{key}</dt>
          <dd>{fields[key]?.trim() ? fields[key] : "—"}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
