"use client";

import { FIELD_NAMES } from "@/lib/types";
import type { BulkCardResult } from "@/lib/types";

export function BulkResultsList({ cards }: { cards: BulkCardResult[] }) {
  return (
    <div className="bulk-list">
      {cards.map((card, i) => {
        const ok = card._status === "saved";
        return (
          <div className="bulk-item" key={i}>
            <div className="bulk-item-head">
              <span className="bulk-item-index">Card {i + 1}</span>
              <span className={"bulk-item-tag" + (ok ? "" : " fail")}>
                {ok ? "saved" : "failed"}
              </span>
            </div>
            <div className="bulk-item-fields">
              {FIELD_NAMES.map((key) => (
                <div key={key} className={key === "Address" ? "span-2" : undefined}>
                  <div className="f-label">{key}</div>
                  <div className="f-value">{card[key]?.trim() ? card[key] : "—"}</div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
