import Link from "next/link";
import { signOut } from "@/lib/actions/auth";
import { isTeamRole, requireMembership } from "@/lib/workspace/server";

// Every page under this layout reads workspace data for the signed-in user.
export const dynamic = "force-dynamic";

export default async function ManagerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Server-side guard: a membership in some workspace (admin, manager or
  // owner). Pages narrow this further; RLS enforces every query.
  const membership = await requireMembership();
  const team = isTeamRole(membership.role);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="border-b border-gray-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <div>
              <h1 className="text-lg font-semibold text-gray-900">PropCare-AI</h1>
              <p className="text-xs text-gray-500">{membership.workspaceName}</p>
            </div>
            <nav className="flex gap-4 text-sm">
              <Link href="/dashboard" className="text-gray-600 hover:text-gray-900">
                Requests
              </Link>
              {team && (
                <Link href="/tenants" className="text-gray-600 hover:text-gray-900">
                  Tenants
                </Link>
              )}
            </nav>
          </div>
          <form action={signOut}>
            <button
              type="submit"
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
