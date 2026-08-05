"use client";

export function StatsRow({
  detected,
  saved,
  failed,
}: {
  detected: number;
  saved: number;
  failed: number;
}) {
  return (
    <div className="stats-row">
      <div className="stat-chip">
        <div className="stat-value">{detected}</div>
        <div className="stat-label">Detected</div>
      </div>
      <div className="stat-chip">
        <div className="stat-value good">{saved}</div>
        <div className="stat-label">Saved</div>
      </div>
      <div className="stat-chip">
        <div className={"stat-value" + (failed > 0 ? " bad" : "")}>{failed}</div>
        <div className="stat-label">Failed</div>
      </div>
    </div>
  );
}
