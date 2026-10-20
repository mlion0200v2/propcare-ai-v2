"use client";

import { useActionState } from "react";
import { requestIntakeCode, verifyIntakeCode, type IntakeState } from "@/lib/actions/intake";

const fieldClass =
  "mt-1.5 block w-full border border-line bg-white px-3.5 py-3 text-[15px] text-ink focus:border-pine focus:outline-none focus:ring-1 focus:ring-pine";
const buttonClass = "w-full bg-pine p-4 text-[15px] text-white hover:bg-ink disabled:opacity-60";

const initial: IntakeState = { step: "details", error: null };

export function IntakeForm({ token }: { token: string }) {
  const [sendState, sendAction, sending] = useActionState(requestIntakeCode, initial);
  const [verifyState, verifyAction, verifying] = useActionState(verifyIntakeCode, initial);

  // Verification errors that send the tenant back (link off, start again).
  const backToDetails = verifyState.error && verifyState.step === "details";
  const showCode = sendState.step === "code" && !backToDetails;

  if (showCode) {
    return (
      <form action={verifyAction} className="flex flex-col gap-4">
        <input type="hidden" name="token" value={token} />
        <input type="hidden" name="name" value={sendState.name ?? ""} />
        <input type="hidden" name="contact" value={sendState.contact ?? ""} />
        <p className="text-sm leading-relaxed text-muted">
          We sent a 6-digit code to <b className="text-ink">{sendState.masked}</b>. It works for 10 minutes.
        </p>
        <label className="text-sm font-medium">
          Code
          <input
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            required
            autoFocus
            className={`${fieldClass} tracking-[0.3em]`}
          />
        </label>
        {verifyState.error && (
          <p role="alert" className="text-sm text-brick">
            {verifyState.error}
          </p>
        )}
        <button type="submit" disabled={verifying} className={buttonClass}>
          {verifying ? "Checking…" : "Start the chat"}
        </button>
      </form>
    );
  }

  const error = backToDetails ? verifyState.error : sendState.error;
  return (
    <form action={sendAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <label className="text-sm font-medium">
        Your name
        <input name="name" autoComplete="name" required maxLength={100} defaultValue={sendState.name} className={fieldClass} />
      </label>
      <label className="text-sm font-medium">
        Mobile number or email
        <input
          name="contact"
          autoComplete="email"
          required
          maxLength={254}
          defaultValue={sendState.contact}
          className={fieldClass}
        />
      </label>
      <p className="-mt-2 text-xs leading-normal text-muted">
        We&apos;ll send a 6-digit code to confirm it&apos;s you, then start the chat. (Codes by text are coming soon;
        email works today.)
      </p>
      {error && (
        <p role="alert" className="text-sm text-brick">
          {error}
        </p>
      )}
      <button type="submit" disabled={sending} className={buttonClass}>
        {sending ? "Sending…" : "Send my code"}
      </button>
    </form>
  );
}
