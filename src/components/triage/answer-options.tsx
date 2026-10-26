"use client";

import { useState } from "react";

/** Long lists show this many lines until "Show more" is tapped. */
const COLLAPSED = 5;

/**
 * Tap answers, one per line (Kitchen / Bedroom / Living room / …), with a
 * "Show more" line when the list is long, and always a last, empty line
 * for the tenant's own words.
 */
export function AnswerOptions({ options, onAnswer }: { options: string[]; onAnswer: (text: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [own, setOwn] = useState("");
  // Collapse only when it hides at least two lines.
  const collapsible = options.length > COLLAPSED + 1;
  const shown = collapsible && !expanded ? options.slice(0, COLLAPSED) : options;

  function sendOwn() {
    const text = own.trim();
    if (!text) return;
    setOwn("");
    onAnswer(text);
  }

  const line = "flex min-h-11 w-full items-center rounded-lg border px-3 py-2 text-left text-sm";
  return (
    <div role="group" aria-label="Answers" className="mb-2 space-y-1.5">
      {shown.map((option) => (
        <button key={option} type="button" onClick={() => onAnswer(option)} className={`${line} border-pine bg-white text-pine hover:bg-sage`}>
          {option}
        </button>
      ))}
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className={`${line} border-dashed border-gray-300 bg-white text-gray-600 hover:bg-gray-50`}
        >
          {expanded ? "Show fewer" : `Show ${options.length - COLLAPSED} more`}
        </button>
      )}
      <div className={`${line} gap-2 border-gray-300 bg-white focus-within:border-pine focus-within:ring-1 focus-within:ring-pine`}>
        <input
          value={own}
          onChange={(e) => setOwn(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              sendOwn();
            }
          }}
          placeholder="Something else? Type it here"
          aria-label="Your own answer"
          className="min-w-0 flex-1 bg-transparent text-gray-900 placeholder:text-gray-500 focus:outline-none"
        />
        <button
          type="button"
          onClick={sendOwn}
          disabled={!own.trim()}
          className="rounded-md px-2 py-1 text-sm font-medium text-pine disabled:text-gray-400"
        >
          Send
        </button>
      </div>
    </div>
  );
}
