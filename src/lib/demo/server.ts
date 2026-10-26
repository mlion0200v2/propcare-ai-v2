import "server-only";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { ACTIVE_WORKSPACE_COOKIE } from "@/lib/workspace/server";
import { logError } from "@/lib/logger";
import { DEMO_COOKIE, MAX_LIVE_SANDBOXES, type DemoRole } from "./config";
import type { Database } from "@/lib/supabase/database-generated";

export type Sandbox = Database["public"]["Tables"]["demo_sandboxes"]["Row"];

const cookieOptions = (maxAgeSeconds: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: maxAgeSeconds,
});

/** This browser's live sandbox, or null (none, expired, or demo mode off). */
export async function getSandbox(): Promise<Sandbox | null> {
  const id = (await cookies()).get(DEMO_COOKIE)?.value;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { data } = await createServiceClient()
    .from("demo_sandboxes")
    .select("*")
    .eq("id", id)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  return data ?? null;
}

/**
 * Four demo auth users with reserved example.com addresses (nothing is ever
 * sent to them) and the seeded "Demo Rentals" workspace.
 */
export async function createSandbox(): Promise<Sandbox> {
  const service = createServiceClient();

  const { count } = await service
    .from("demo_sandboxes")
    .select("id", { count: "exact", head: true })
    .gt("expires_at", new Date().toISOString());
  if ((count ?? 0) >= MAX_LIVE_SANDBOXES) throw new Error("demo_capacity");

  const tag = randomBytes(6).toString("hex");
  const people: Record<"admin" | "owner" | "tenant" | "neighbour", string> = {
    admin: "Sam Rivera",
    owner: "Riley Chen",
    tenant: "Jamie Lee",
    neighbour: "Priya Shah",
  };
  const ids: Partial<Record<keyof typeof people, string>> = {};
  try {
    for (const [role, fullName] of Object.entries(people) as [keyof typeof people, string][]) {
      const { data, error } = await service.auth.admin.createUser({
        email: `demo-${tag}-${role}@example.com`,
        email_confirm: true,
        user_metadata: { full_name: fullName, demo: true },
      });
      if (error || !data.user) throw error ?? new Error("createUser failed");
      ids[role] = data.user.id;
    }
    const { data: sandboxId, error } = await service.rpc("create_demo_sandbox", {
      p_admin: ids.admin!,
      p_owner: ids.owner!,
      p_tenant: ids.tenant!,
      p_neighbour: ids.neighbour!,
    });
    if (error || !sandboxId) throw error ?? new Error("create_demo_sandbox failed");
    const { data: sandbox } = await service.from("demo_sandboxes").select("*").eq("id", sandboxId).single();
    if (!sandbox) throw new Error("sandbox missing");

    (await cookies()).set(DEMO_COOKIE, sandbox.id, cookieOptions(24 * 60 * 60));
    return sandbox;
  } catch (err) {
    // Don't leave half a sandbox behind.
    for (const id of Object.values(ids)) {
      if (id) await service.auth.admin.deleteUser(id).catch(() => undefined);
    }
    throw err;
  }
}

function userForRole(sandbox: Sandbox, role: Exclude<DemoRole, "vendor">): string | null {
  return role === "manager" ? sandbox.admin_id : role === "owner" ? sandbox.owner_id : sandbox.tenant_id;
}

/**
 * Sign this browser in as one of the sandbox's demo users. Uses an admin
 * magic-link token verified on the spot: no email is sent.
 */
export async function signInAsDemoRole(sandbox: Sandbox, role: Exclude<DemoRole, "vendor">): Promise<void> {
  const userId = userForRole(sandbox, role);
  if (!userId) throw new Error("demo user missing");
  const service = createServiceClient();
  const { data: user } = await service.auth.admin.getUserById(userId);
  const email = user.user?.email;
  if (!email) throw new Error("demo user has no email");

  const { data: link, error } = await service.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link?.properties?.hashed_token;
  if (error || !tokenHash) throw error ?? new Error("generateLink failed");

  const supabase = await createClient();
  let { error: verifyError } = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (verifyError) ({ error: verifyError } = await supabase.auth.verifyOtp({ type: "email", token_hash: tokenHash }));
  if (verifyError) throw verifyError;

  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, sandbox.workspace_id, cookieOptions(24 * 60 * 60));
}

/** Who this browser currently is inside the sandbox (vendor is decided by the page). */
export function roleOfUser(sandbox: Sandbox, userId: string | null | undefined): DemoRole | null {
  if (!userId) return null;
  if (userId === sandbox.admin_id) return "manager";
  if (userId === sandbox.owner_id) return "owner";
  if (userId === sandbox.tenant_id) return "tenant";
  return null;
}

/** What the switcher needs to keep the same ticket in view across roles. */
export async function ticketContext(sandbox: Sandbox, ticketId: string | null) {
  const service = createServiceClient();
  const id = ticketId ?? sandbox.focus_ticket_id;
  if (!id) return null;
  const { data: ticket } = await service
    .from("tickets")
    .select("id, workspace_id, tenant_id, tenancy_id, unit_id, title, description, classification, units(property_id)")
    .eq("id", id)
    .eq("workspace_id", sandbox.workspace_id)
    .maybeSingle();
  if (!ticket) return null;

  const [{ data: access }, { data: tenancy }, { data: order }] = await Promise.all([
    service
      .from("owner_property_access")
      .select("property_id")
      .eq("user_id", sandbox.owner_id ?? "")
      .eq("property_id", ticket.units?.property_id ?? ""),
    ticket.tenancy_id
      ? service.from("tenancies").select("tenant_user_id").eq("id", ticket.tenancy_id).maybeSingle()
      : Promise.resolve({ data: null }),
    service
      .from("work_orders")
      .select("token")
      .eq("ticket_id", ticket.id)
      .neq("status", "cancelled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  let vendorToken = order?.token ?? null;
  if (!vendorToken) {
    // The vendor view needs a work order: send this ticket to the demo vendor.
    const { data: vendor } = await service
      .from("vendors")
      .select("id, name")
      .eq("workspace_id", sandbox.workspace_id)
      .limit(1)
      .maybeSingle();
    const { data: created } = await service
      .from("work_orders")
      .insert({
        ticket_id: ticket.id,
        workspace_id: sandbox.workspace_id,
        vendor_id: vendor?.id ?? null,
        vendor_name: vendor?.name ?? "Westside Plumbing",
        scope: (ticket.description ?? ticket.title).slice(0, 4000),
        access_window: "Weekdays 9 a.m. to 5 p.m.",
        entry_permission: true,
        include_tenant_phone: true,
        created_by: sandbox.admin_id,
      })
      .select("token")
      .single();
    vendorToken = created?.token ?? null;
  }

  return {
    id: ticket.id,
    ownerCanSee: (access ?? []).length > 0,
    tenantCanSee: ticket.tenant_id === sandbox.tenant_id || tenancy?.tenant_user_id === sandbox.tenant_id,
    vendorToken,
  };
}

/** Delete expired sandboxes: workspace (cascades all rows), then demo users. */
export async function cleanupExpiredSandboxes(limit = 100): Promise<number> {
  const service = createServiceClient();
  const { data: expired } = await service
    .from("demo_sandboxes")
    .select("id, workspace_id, admin_id, owner_id, tenant_id, neighbour_id")
    .lt("expires_at", new Date().toISOString())
    .limit(limit);
  let removed = 0;
  for (const s of expired ?? []) {
    const { error } = await service.from("workspaces").delete().eq("id", s.workspace_id);
    if (error) {
      logError("demo_cleanup_workspace", error, { sandbox: s.id });
      continue;
    }
    for (const userId of [s.admin_id, s.owner_id, s.tenant_id, s.neighbour_id]) {
      if (userId) await service.auth.admin.deleteUser(userId).catch((err) => logError("demo_cleanup_user", err));
    }
    removed++;
  }
  return removed;
}
