import { useId, useRef, useState, type DragEvent } from "react";

export interface FileDropProps {
  readonly disabled: boolean;
  readonly file: File | null;
  readonly onFile: (file: File) => void;
}

const ACCEPTED_FILES = ".html,.htm,.md,.markdown,.pdf,text/html,text/markdown,application/pdf";

export function FileDrop({ disabled, file, onFile }: FileDropProps) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const chooseFirst = (files: FileList | null) => {
    const nextFile = files?.item(0);
    if (nextFile !== null && nextFile !== undefined) onFile(nextFile);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    if (!disabled) chooseFirst(event.dataTransfer.files);
  };

  return (
    <div
      className={`file-drop${file === null ? "" : " file-drop--selected"}${isDragging ? " file-drop--active" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsDragging(false);
        }
      }}
      onDrop={onDrop}
    >
      <input
        ref={input}
        id={inputId}
        className="visually-hidden"
        type="file"
        accept={ACCEPTED_FILES}
        disabled={disabled}
        onChange={(event) => chooseFirst(event.currentTarget.files)}
      />
      <div className="file-drop__mark" aria-hidden="true">{file === null ? "+" : fileKind(file)}</div>
      {file === null ? (
        <>
          <p className="file-drop__title">Drop one artifact here</p>
          <p className="file-drop__detail">HTML, Markdown, or PDF</p>
        </>
      ) : (
        <>
          <p className="file-drop__state">Selected document</p>
          <p className="file-drop__title">{file.name}</p>
          <p className="file-drop__detail">{formatBytes(file.size)}</p>
        </>
      )}
      <button
        className="text-button"
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {file === null ? "Choose a file" : "Replace document"}
      </button>
    </div>
  );
}

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const fileKind = (file: File): string => {
  const extension = file.name.split(".").pop()?.toUpperCase() ?? "FILE";
  if (extension === "MARKDOWN") return "MD";
  if (extension === "HTM") return "HTML";
  return extension;
};
