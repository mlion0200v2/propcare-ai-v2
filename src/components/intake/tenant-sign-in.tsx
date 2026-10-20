"use client";

import { useActionState } from "react";
import { requestTenantSignInLink, type SimpleState } from "@/lib/actions/intake";

const initial: SimpleState = { error: null, ok: null };

export function TenantSignInForm() {
  const [state, action, pending] = useActionState(requestTenantSignInLink, initial);
  return (
    <form action={action} className="space-y-3 rounded-xl border border-line bg-white px-6 py-5">
      <h2 className="text-base font-semibold">Tenant? Sign in without a password</h2>
      <p className="text-sm text-muted">We&apos;ll email you a link to see your requests and replies.</p>
      <label className="block text-sm font-medium">
        Email
        <input
          name="email"
          type="email"
          required
          autoComplete="email"
          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-brick">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p role="status" className="text-sm text-pine">
          {state.ok}
        </p>
      )}
      <button type="submit" disabled={pending} className="w-full rounded-lg border border-pine px-4 py-2 text-sm text-pine hover:bg-sage">
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
    </form>
  );
}
