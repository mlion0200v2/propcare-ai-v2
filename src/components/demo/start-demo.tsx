"use client";

import { useActionState } from "react";
import { startDemo, type DemoState } from "@/lib/actions/demo";

const initial: DemoState = { error: null };

export function StartDemoButtons() {
  const [state, action, pending] = useActionState(startDemo, initial);
  return (
    <form action={action} className="space-y-4">
      <h2 className="font-display text-3xl">Where do you want to start?</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <button
          type="submit"
          name="view"
          value="tenant"
          disabled={pending}
          className="flex flex-col items-start gap-2 border-2 border-pine bg-white p-5 text-left hover:bg-sage disabled:opacity-60"
        >
          <b className="text-[17px]">Report a problem as a tenant</b>
          <span className="text-sm leading-relaxed text-muted">
            Open the unit&apos;s link and chat: safety check first, then what to try and what to photograph.
          </span>
        </button>
        <button
          type="submit"
          name="view"
          value="manager"
          disabled={pending}
          className="flex flex-col items-start gap-2 border border-line bg-white p-5 text-left hover:border-pine hover:bg-sage disabled:opacity-60"
        >
          <b className="text-[17px]">See the manager&apos;s side</b>
          <span className="text-sm leading-relaxed text-muted">
            A request waiting for the owner&apos;s OK on a $340 quote, an emergency, and one fixed in the chat.
          </span>
        </button>
      </div>
      {pending && (
        <p role="status" className="text-sm text-muted">
          Setting up your sample workspace…
        </p>
      )}
      {state.error && (
        <p role="alert" className="text-sm text-brick">
          {state.error}
        </p>
      )}
    </form>
  );
}
