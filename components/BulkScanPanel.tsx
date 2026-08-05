"use client";

import { useState, useCallback, useEffect } from "react";
import { Dropzone } from "./Dropzone";
import { StatsRow } from "./StatsRow";
import { BulkResultsList } from "./BulkResultsList";
import { CheckIcon, AlertIcon, GridIcon } from "./icons";
import type { BulkScanResult } from "@/lib/types";

export function BulkScanPanel() {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<{ text: string; kind: "" | "ok" | "err" }>({
    text: "",
    kind: "",
  });
  const [result, setResult] = useState<BulkScanResult | null>(null);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFile = useCallback((f: File) => {
    setFile(f);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(f);
    });
    setStatus({ text: "", kind: "" });
    setResult(null);
  }, []);

  const handleScan = async () => {
    if (!file) return;
    setStatus({
      text: "Detecting and reading cards — this can take a while for large batches…",
      kind: "",
    });
    setScanning(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/scan/bulk", { method: "POST", body: fd });
      
      const rawText = await res.text();
      let data: BulkScanResult | { detail?: string; message?: string } | null = null;
      try {
        data = JSON.parse(rawText);
      } catch {
        if (!res.ok) {
          throw new Error(`Server returned HTTP ${res.status}: ${res.statusText || rawText.slice(0, 150)}`);
        }
        throw new Error("Server response was not valid JSON.");
      }

      if (!res.ok) {
        const errorDetail = (data as { detail?: string; message?: string })?.detail || (data as { detail?: string; message?: string })?.message || "Scan failed";
        throw new Error(errorDetail);
      }

      const scanResult = data as BulkScanResult;
      setResult(scanResult);
      setStatus({ text: scanResult.message, kind: scanResult.saved > 0 ? "ok" : "err" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus({ text: message, kind: "err" });
    } finally {
      setScanning(false);
    }
  };

  return (
    <section className="panel active">
      <div className="upload-card">
        <Dropzone
          onFile={handleFile}
          previewUrl={previewUrl}
          emptyState={
            <>
              <div className="dz-icon-wrap">
                <GridIcon />
              </div>
              <h3>Upload bulk photo</h3>
              <p>Drop a photo containing 20-30+ cards laid flat</p>
              <p className="dz-hint">Ensure cards are spaced apart on a contrasting plain background</p>
            </>
          }
        />
        <button
          className="btn btn-primary"
          disabled={!file || scanning}
          onClick={handleScan}
          type="button"
        >
          <span className="btn-text" style={{ opacity: scanning ? 0.55 : 1 }}>
            Scan &amp; Save All Cards
          </span>
          {scanning && <span className="loader" />}
        </button>
        <p className={"status-line" + (status.kind ? ` ${status.kind}` : "")}>{status.text}</p>
      </div>

      {result && (
        <div className="result-card">
          <div className="result-header">
            <div className={"result-indicator " + (result.saved > 0 ? "indicator-ok" : "indicator-fail")}>
              {result.saved > 0 ? <CheckIcon /> : <AlertIcon />}
            </div>
            <h2>Scan Result</h2>
          </div>
          <StatsRow detected={result.detected} saved={result.saved} failed={result.failed} />
          {result.cards.length > 0 && <BulkResultsList cards={result.cards} />}
        </div>
      )}
    </section>
  );
}
