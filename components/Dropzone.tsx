"use client";

import { useRef, useState, useCallback, ReactNode } from "react";

interface DropzoneProps {
  onFile: (file: File) => void;
  previewUrl: string | null;
  emptyState: ReactNode;
}

export function Dropzone({ onFile, previewUrl, emptyState }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (file) onFile(file);
    },
    [onFile]
  );

  return (
    <div
      className={"dropzone" + (dragOver ? " dragover" : "")}
      onClick={() => inputRef.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        handleFiles(e.dataTransfer.files);
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={previewUrl} className="dropzone-preview" alt="Selected business card preview" />
      ) : (
        <div className="dropzone-empty">{emptyState}</div>
      )}
    </div>
  );
}
