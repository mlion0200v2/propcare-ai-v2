"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { clientIp } from "@/lib/request-ip";
import { demoCreateLimiter } from "@/lib/rate-limit";
import { logError } from "@/lib/logger";
import {
  DEMO_COOKIE,
  DEMO_ROLES,
  demoDestination,
  isDemoMode,
  ticketIdFromPath,
  vendorTokenFromPath,
  type DemoRole,
} from "@/lib/demo/config";
import { createSandbox, getSandbox, signInAsDemoRole, ticketContext, type Sandbox } from "@/lib/demo/server";

export type DemoState = { error: string | null };

/** /try: "Report a problem as a tenant" or "See the manager's side". */
export async function startDemo(_prev: DemoState, formData: FormData): Promise<DemoState> {
  if (!isDemoMode()) return { error: "The demo is not available here." };
  const view = formData.get("view") === "tenant" ? "tenant" : "manager";

  let sandbox = await getSandbox();
  if (!sandbox) {
    if (!demoCreateLimiter.check(await clientIp()).allowed) {
      return { error: "Too many demos from this network. Please try again in an hour." };
    }
    try {
      sandbox = await createSandbox();
    } catch (err) {
      logError("demo_create", err);
      return {
        error:
          err instanceof Error && err.message === "demo_capacity"
            ? "The demo is busy right now. Please try again later."
            : "Couldn't start the demo. Please try again.",
      };
    }
  }

  let destination: string;
  try {
    if (view === "tenant") {
      await signInAsDemoRole(sandbox, "tenant");
      destination = await tenantReportPath(sandbox);
    } else {
      await signInAsDemoRole(sandbox, "manager");
      destination = sandbox.focus_ticket_id ? `/tickets/${sandbox.focus_ticket_id}` : "/dashboard";
    }
  } catch (err) {
    logError("demo_sign_in", err);
    return { error: "Couldn't start the demo. Please try again." };
  }
  redirect(destination);
}

/** The tenant's unit link, straight into the chat (the demo skips the one-time code). */
async function tenantReportPath(sandbox: Sandbox): Promise<string> {
  const { data } = await createServiceClient()
    .from("tenancies")
    .select("id, units(intake_token)")
    .eq("tenant_user_id", sandbox.tenant_id ?? "")
    .eq("workspace_id", sandbox.workspace_id)
    .limit(1)
    .maybeSingle();
  return data?.units?.intake_token ? `/r/${data.units.intake_token}/chat?t=${data.id}` : "/my-requests";
}

/** Role switcher: same ticket, another perspective, one click. */
export async function switchDemoRole(formData: FormData): Promise<void> {
  if (!isDemoMode()) redirect("/");
  const sandbox = await getSandbox();
  if (!sandbox) redirect("/try?expired=1");

  const role = String(formData.get("role")) as DemoRole;
  if (!DEMO_ROLES.includes(role)) redirect("/");
  const pathname = String(formData.get("pathname") ?? "");

  // Which ticket is on screen? A vendor page names it by work-order token.
  let ticketId = ticketIdFromPath(pathname);
  const vendorToken = vendorTokenFromPath(pathname);
  if (!ticketId && vendorToken) {
    const { data } = await createServiceClient()
      .from("work_orders")
      .select("ticket_id")
      .eq("token", vendorToken)
      .eq("workspace_id", sandbox.workspace_id)
      .maybeSingle();
    ticketId = data?.ticket_id ?? null;
  }

  const ticket = await ticketContext(sandbox, ticketId);
  if (role !== "vendor") {
    try {
      await signInAsDemoRole(sandbox, role);
    } catch (err) {
      logError("demo_switch", err, { role });
      redirect("/try?error=1");
    }
  }
  redirect(demoDestination(role, ticket));
}

/** Leave the demo: sign out and forget the sandbox (it expires on its own). */
export async function endDemo(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  (await cookies()).delete(DEMO_COOKIE);
  redirect("/try");
}
