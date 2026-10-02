"use client";

import { useEffect, useRef, useState } from "react";
import { HexColorInput, HexColorPicker } from "react-colorful";

/** Sheets-style presets: strong colours on top, pastel tints below. */
const PRESETS = [
  "#ff0000", "#ff9900", "#ffff00", "#34a853", "#00bcd4", "#4285f4", "#9c27b0", "#000000",
  "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#cfe2f3", "#d9d2e9", "#b7b7b7",
];

export default function ColorPicker({
  color,
  onChange,
  disabled,
}: {
  color: string;
  onChange: (hex: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  // Close on click-outside / Escape so the popover never traps the form.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className="flex w-full items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm outline-none transition hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/5"
      >
        <span
          className="h-5 w-5 shrink-0 rounded border"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <span className="font-mono uppercase">{color}</span>
        <span className="ml-auto text-muted">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 z-40 mt-2 w-60 rounded-xl border bg-card p-3 shadow-lg">
          <HexColorPicker color={color} onChange={onChange} style={{ width: "100%" }} />

          <div className="mt-3 grid grid-cols-8 gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onChange(p)}
                title={p}
                className={`h-5 w-full rounded border transition hover:scale-110 ${
                  p.toLowerCase() === color.toLowerCase() ? "ring-2 ring-blue-500" : ""
                }`}
                style={{ backgroundColor: p }}
              />
            ))}
          </div>

          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-muted">HEX</span>
            <HexColorInput
              color={color}
              onChange={onChange}
              prefixed
              className="w-full rounded-lg border bg-background px-2 py-1.5 font-mono text-sm uppercase outline-none focus:ring-2 focus:ring-blue-500/40"
            />
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
            >
              OK
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
