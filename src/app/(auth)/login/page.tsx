"use client";

import { useActionState } from "react";
import Link from "next/link";
import { signIn, type AuthState } from "@/lib/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const initialState: AuthState = { error: null };

export default function LoginPage() {
  const [state, formAction, isPending] = useActionState(signIn, initialState);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in to PropCare-AI</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="space-y-4">
          {state.error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {state.error}
            </div>
          )}

          <Input
            id="email"
            name="email"
            type="email"
            label="Email"
            placeholder="you@example.com"
            required
            autoComplete="email"
          />

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
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="font-medium text-blue-600 hover:text-blue-500">
              Sign up
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
