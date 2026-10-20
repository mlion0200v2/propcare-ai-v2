"use client";

export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="bg-pine px-5 py-3 text-sm text-white print:hidden">
      Print poster
    </button>
  );
}
