import { createClient } from "@/lib/supabase/server";
import { requireTeam } from "@/lib/workspace/server";
import { changeMemberRole, removeMember, revokeInvitation, setOwnerProperties } from "@/lib/actions/workspace";
import { InviteForm, secondaryButton } from "@/components/workspace/forms";

export const metadata = {
  title: "Team and owners | PropCare",
};

const ROLE_LABELS: Record<string, string> = { admin: "Admin", manager: "Manager", owner: "Owner" };

export default async function TeamPage() {
  const membership = await requireTeam();
  const isAdmin = membership.role === "admin";
  const company = membership.kind === "company";
  const supabase = await createClient();

  const [{ data: members }, { data: properties }, { data: access }, { data: invitations }] = await Promise.all([
    supabase
      .from("memberships")
      .select("user_id, role, display_name, created_at")
      .eq("workspace_id", membership.workspaceId)
      .order("created_at"),
    supabase
      .from("properties")
      .select("id, address_line1")
      .eq("workspace_id", membership.workspaceId)
      .order("address_line1"),
    supabase.from("owner_property_access").select("user_id, property_id").eq("workspace_id", membership.workspaceId),
    isAdmin
      ? supabase
          .from("invitations")
          .select("id, email, role, expires_at, created_at")
          .eq("workspace_id", membership.workspaceId)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [] as { id: string; email: string; role: string; expires_at: string; created_at: string }[] }),
  ]);

  const memberIds = (members ?? []).map((m) => m.user_id);
  const { data: profiles } = memberIds.length
    ? await supabase.from("profiles").select("id, full_name, email").in("id", memberIds)
    : { data: [] as { id: string; full_name: string; email: string | null }[] };
  const profileById = new Map((profiles ?? []).map((p) => [p.id, p]));
  const propertyOptions = (properties ?? []).map((p) => ({ id: p.id, label: p.address_line1 }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-[34px] leading-tight">{company ? "Team and owners" : "Team"}</h1>
        <p className="mt-2 max-w-2xl text-[15px] text-muted">
          {company
            ? "Managers see every request. Owners see only the homes you choose, never notes marked “team only”."
            : "Managers you invite see every request in this workspace."}
        </p>
      </div>

      <section className="border border-line bg-white p-6 sm:p-7">
        <h2 className="text-lg font-semibold">Members</h2>
        <ul className="mt-3 divide-y divide-line">
          {(members ?? []).map((m) => {
            const profile = profileById.get(m.user_id);
            const isSelf = m.user_id === membership.userId;
            const owned = new Set((access ?? []).filter((a) => a.user_id === m.user_id).map((a) => a.property_id));
            return (
              <li key={m.user_id} className="space-y-3 py-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[15px] font-medium">
                      {m.display_name ?? profile?.full_name ?? "Member"} {isSelf && <span className="text-muted">(you)</span>}
                    </p>
                    <p className="text-sm text-muted">{profile?.email}</p>
                  </div>
                  {isAdmin && !isSelf ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <form action={changeMemberRole} className="flex items-center gap-2">
                        <input type="hidden" name="user_id" value={m.user_id} />
                        <label className="sr-only" htmlFor={`role-${m.user_id}`}>
                          Role
                        </label>
                        <select
                          id={`role-${m.user_id}`}
                          name="role"
                          defaultValue={m.role}
                          className="border border-line bg-paper px-2 py-2 text-sm"
                        >
                          <option value="admin">Admin</option>
                          <option value="manager">Manager</option>
                          {company && <option value="owner">Owner</option>}
                        </select>
                        <button type="submit" className={secondaryButton}>
                          Change
                        </button>
                      </form>
                      <form action={removeMember}>
                        <input type="hidden" name="user_id" value={m.user_id} />
                        <button type="submit" className="px-2 py-2.5 text-sm text-brick underline">
                          Remove
                        </button>
                      </form>
                    </div>
                  ) : (
                    <span className="bg-sage px-2.5 py-1 text-xs font-semibold text-pine">{ROLE_LABELS[m.role]}</span>
                  )}
                </div>
                {m.role === "owner" && (
                  <form action={setOwnerProperties} className="border-l-2 border-gold pl-4">
                    <input type="hidden" name="user_id" value={m.user_id} />
                    <p className="text-sm font-medium">Homes this owner sees</p>
                    <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                      {propertyOptions.map((p) => (
                        <label key={p.id} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            name="property_ids"
                            value={p.id}
                            defaultChecked={owned.has(p.id)}
                            disabled={!isAdmin}
                            className="accent-pine"
                          />
                          {p.label}
                        </label>
                      ))}
                    </div>
                    {isAdmin && (
                      <button type="submit" className={`${secondaryButton} mt-3`}>
                        Save homes
                      </button>
                    )}
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {isAdmin && (
        <section className="border border-line bg-white p-6 sm:p-7">
          <h2 className="text-lg font-semibold">Invite someone</h2>
          <p className="mt-1 text-sm text-muted">They get an email with a link that works once, for 14 days.</p>
          <div className="mt-4">
            <InviteForm allowOwners={company} properties={propertyOptions} />
          </div>
          {(invitations ?? []).length > 0 && (
            <div className="mt-6 border-t border-line pt-5">
              <h3 className="text-sm font-semibold">Waiting to be accepted</h3>
              <ul className="mt-2 divide-y divide-line">
                {(invitations ?? []).map((inv) => (
                  <li key={inv.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                    <span>
                      {inv.email} · {ROLE_LABELS[inv.role]} · expires {new Date(inv.expires_at).toLocaleDateString("en-CA")}
                    </span>
                    <form action={revokeInvitation}>
                      <input type="hidden" name="invitation_id" value={inv.id} />
                      <button type="submit" className="text-brick underline">
                        Revoke
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
