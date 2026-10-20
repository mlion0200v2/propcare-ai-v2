import { signOut } from "@/lib/actions/auth";
import { switchWorkspace } from "@/lib/actions/workspace";
import { getMemberships, isTeamRole, requireMembership } from "@/lib/workspace/server";
import { WorkspaceNav } from "@/components/workspace/nav";

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
  const memberships = await getMemberships();
  const team = isTeamRole(membership.role);

  const links = [
    { href: "/dashboard", label: "Requests" },
    ...(team
      ? [
          { href: "/homes", label: "Homes and units" },
          { href: "/tenants", label: "Tenants" },
          { href: "/team", label: membership.kind === "company" ? "Team and owners" : "Team" },
        ]
      : []),
    ...(membership.role === "admin" ? [{ href: "/settings", label: "Settings" }] : []),
  ];

  return (
    <div className="min-h-screen bg-paper font-brand text-ink md:grid md:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="border-b border-line bg-white px-4 py-5 md:border-b-0 md:border-r md:px-5 md:py-7">
        <p className="font-display text-xl text-pine">PropCare</p>
        {memberships.length > 1 ? (
          <form action={switchWorkspace} className="mt-1 mb-5">
            <label className="sr-only" htmlFor="workspace_id">
              Workspace
            </label>
            <select
              id="workspace_id"
              name="workspace_id"
              defaultValue={membership.workspaceId}
              className="w-full border border-line bg-paper px-2 py-1.5 text-[13px] text-muted"
            >
              {memberships.map((m) => (
                <option key={m.workspaceId} value={m.workspaceId}>
                  {m.workspaceName}
                </option>
              ))}
            </select>
            <button type="submit" className="mt-1 text-xs text-pine underline">
              Switch
            </button>
          </form>
        ) : (
          <p className="mt-1 mb-5 text-[13px] text-muted">{membership.workspaceName}</p>
        )}
        <WorkspaceNav links={links} />
        <form action={signOut} className="mt-6">
          <button type="submit" className="px-3 text-sm text-muted hover:text-ink">
            Sign out
          </button>
        </form>
      </aside>
      <main className="min-w-0 px-4 py-8 md:px-12 md:py-10">{children}</main>
    </div>
  );
}
