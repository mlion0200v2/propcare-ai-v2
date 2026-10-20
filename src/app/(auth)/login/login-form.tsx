"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signIn, type AuthState } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const initialState: AuthState = { error: null };

export function LoginForm({ next, linkError }: { next?: string; linkError?: boolean }) {
  const [state, formAction, isPending] = useActionState(signIn, initialState);
  const error = state.error ?? (linkError ? "That link has expired or was already used. Sign in, or ask for a new link." : null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in to PropCare</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {error && (
            <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          {next && <input type="hidden" name="next" value={next} />}

          <Input id="email" name="email" type="email" label="Email" placeholder="you@example.com" required autoComplete="email" />

          <Input
            id="password"
            name="password"
            type="password"
            label="Password"
            placeholder="********"
            required
            autoComplete="current-password"
          />

          <Button type="submit" disabled={isPending} className="w-full">
            {isPending ? "Signing in..." : "Sign in"}
          </Button>

          <p className="text-center text-sm text-gray-600">
            Landlord or property manager?{" "}
            <Link href="/signup" className="font-medium text-pine underline">
              Create a workspace
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
