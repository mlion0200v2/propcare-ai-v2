"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { saveTenantAccount, type SimpleState } from "@/lib/actions/intake";

const initial: SimpleState = { error: null, ok: null };

/** Shown after a request is sent: optional passwordless account (TenantLink board). */
export function KeepAccountCard({ isGuest, reportAgainHref }: { isGuest: boolean; reportAgainHref: string }) {
  const [state, action, pending] = useActionState(saveTenantAccount, initial);
  const [dismissed, setDismissed] = useState(false);

  return (
    <div className="space-y-4">
      {isGuest && !dismissed && (
        <div className="border border-line bg-white p-5">
          <p className="text-base font-semibold text-ink">Keep track of your requests?</p>
          {state.ok ? (
            <p role="status" className="mt-2 text-sm leading-relaxed text-pine">
              {state.ok}
            </p>
          ) : (
            <form action={action}>
              <p className="mt-2 text-sm leading-relaxed text-muted">
                Save an account for this home: see replies, and skip your details next time. No password: we email you a
                sign-in link.
              </p>
              <label className="mt-3.5 block text-sm font-medium text-ink">
                Email
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  className="mt-1.5 block w-full border border-line bg-white px-3.5 py-3 text-[15px]"
                />
              </label>
              {state.error && (
                <p role="alert" className="mt-2 text-sm text-brick">
                  {state.error}
                </p>
              )}
              <button
                type="submit"
                disabled={pending}
                className="mt-3.5 w-full bg-pine p-3.5 text-[15px] text-white hover:bg-ink disabled:opacity-60"
              >
                {pending ? "Sending…" : "Create my account"}
              </button>
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="mt-2 w-full p-3 text-sm text-ink underline"
              >
                Not now
              </button>
            </form>
          )}
        </div>
      )}
      {!isGuest && (
        <p className="text-sm text-muted">
          <Link href="/my-requests" className="text-pine underline">
            See all your requests
          </Link>
        </p>
      )}
      <p className="text-xs text-muted">
        Something else?{" "}
        <a href={reportAgainHref} className="text-pine underline">
          Report another problem
        </a>{" "}
        from the same link.
      </p>
    </div>
  );
}
