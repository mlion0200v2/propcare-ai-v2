"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { signUp, type AuthState } from "@/lib/actions/auth";

const initialState: AuthState = { error: null, sentTo: null };

const inputClass =
  "mt-1.5 block w-full border border-line bg-paper px-3.5 py-3 text-[15px] text-ink focus:border-pine focus:outline-none focus:ring-1 focus:ring-pine";

export function SignUpForm({ invite, inviteEmail }: { invite?: string; inviteEmail?: string }) {
  const [state, formAction, isPending] = useActionState(signUp, initialState);
  const [kind, setKind] = useState<"individual" | "company">("individual");

  if (state.sentTo) {
    return (
      <div role="status" className="space-y-3">
        <h2 className="font-display text-3xl text-ink">Check your email</h2>
        <p className="text-[15px] leading-relaxed text-muted">
          We sent a confirmation link to <b className="text-ink">{state.sentTo}</b>. Open it on this device to
          {invite ? " join the workspace." : " finish creating your workspace."}
        </p>
        <p className="text-sm text-muted">Nothing there? Check spam, or sign up again in a few minutes.</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-6">
      <div>
        <h2 className="font-display text-3xl text-ink">{invite ? "Create your account" : "Create your workspace"}</h2>
        <p className="mt-2 text-[15px] text-muted">
          {invite
            ? "You were invited to a PropCare workspace. Create a login to join it."
            : "Tenants don't sign up here. They use the link you send them."}
        </p>
      </div>

      {state.error && (
        <div role="alert" className="border border-brick/30 bg-brick/5 px-3 py-2 text-sm text-brick">
          {state.error}
        </div>
      )}

      {invite ? (
        <input type="hidden" name="invite" value={invite} />
      ) : (
        <fieldset className="min-w-0">
          <legend className="mb-3 text-sm font-semibold text-ink">Which describes you?</legend>
          <div className="grid gap-3.5 sm:grid-cols-2">
            {(
              [
                ["individual", "I own rentals", "A suite, a condo, or a few homes I look after myself"],
                ["company", "I manage rentals for owners", "A management company; invite your team and owners"],
              ] as const
            ).map(([value, title, hint]) => (
              <label
                key={value}
                className={`flex cursor-pointer items-start gap-3 bg-white p-4 ${
                  kind === value ? "border-2 border-pine" : "border border-line"
                }`}
              >
                <input
                  type="radio"
                  name="workspace_kind"
                  value={value}
                  checked={kind === value}
                  onChange={() => setKind(value)}
                  className="mt-1 accent-pine"
                />
                <span>
                  <b className="block text-[15px] text-ink">{title}</b>
                  <span className="mt-1 block text-[13px] leading-normal text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-ink">
          Your name
          <input className={inputClass} name="full_name" type="text" required autoComplete="name" maxLength={100} />
        </label>
        <label className="text-sm font-medium text-ink">
          Email
          <input
            className={inputClass}
            name="email"
            type="email"
            required
            autoComplete="email"
            defaultValue={inviteEmail}
          />
        </label>
        {!invite && (
          <label className="text-sm font-medium text-ink">
            Workspace name
            <input
              className={inputClass}
              name="workspace_name"
              type="text"
              required
              maxLength={120}
              placeholder={kind === "company" ? "e.g. Birchwood Management" : "e.g. Main Street rentals"}
            />
          </label>
        )}
        <label className="text-sm font-medium text-ink">
          Password
          <input
            className={inputClass}
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
          />
        </label>
      </div>

      <label className="flex items-start gap-2.5 text-[13px] leading-normal text-muted">
        <input type="checkbox" name="accept_terms" required className="mt-0.5 accent-pine" />
        I agree to the terms and the privacy policy, and I&apos;ll tell my tenants how their requests are handled.
      </label>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={isPending}
          className="bg-pine px-7 py-4 text-[15px] text-white hover:bg-ink disabled:opacity-60"
        >
          {isPending ? "Creating…" : invite ? "Create account" : "Create workspace"}
        </button>
        <Link href={invite ? `/login?next=/invite/${encodeURIComponent(invite)}` : "/login"} className="text-sm text-pine underline">
          Already have an account? Sign in
        </Link>
      </div>

      {!invite && (
        <p className="text-[13px] leading-relaxed text-muted">
          Next: we&apos;ll confirm your email, then ask for your first home and its units. Each unit gets its own
          tenant link.
        </p>
      )}
    </form>
  );
}
