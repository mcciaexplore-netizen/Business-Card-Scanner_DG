"use client";

import { useState } from "react";
import { SingleScanPanel } from "@/components/SingleScanPanel";
import { BulkScanPanel } from "@/components/BulkScanPanel";
import { LogoIcon } from "@/components/icons";

type Mode = "single" | "bulk";

export default function Page() {
  const [mode, setMode] = useState<Mode>("single");

  return (
    <>
      <header className="topbar">
        <div className="logo-group">
          <div className="logo-icon">
            <LogoIcon />
          </div>
          <div className="logo-text">
            <h1>AuraScan</h1>
            <span className="logo-badge">Gemini Pro</span>
          </div>
        </div>
        <nav className="mode-switch">
          <button
            className={"mode-btn" + (mode === "single" ? " active" : "")}
            onClick={() => setMode("single")}
            type="button"
          >
            Single Scan
          </button>
          <button
            className={"mode-btn" + (mode === "bulk" ? " active" : "")}
            onClick={() => setMode("bulk")}
            type="button"
          >
            Bulk Scan
          </button>
        </nav>
      </header>

      <main className="layout">
        {/* Only the selected panel is mounted at all - this also means
            switching away from Single Scan fully tears down the camera
            component (and its media stream), not just hides it. */}
        {mode === "single" ? <SingleScanPanel /> : <BulkScanPanel />}
      </main>
    </>
  );
}
