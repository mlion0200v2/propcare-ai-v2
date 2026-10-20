import "server-only";

import type { User } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/server";
import { logError } from "@/lib/triage/logger";

export interface IntakeUnit {
  unit_id: string;
  unit_number: string | null;
  property_id: string;
  address_line1: string;
  city: string;
  workspace_id: string;
  workspace_name: string;
}

/** Active link → unit. Nothing when the link is off, replaced, or unknown. */
export async function findUnitByToken(token: string): Promise<IntakeUnit | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const { data, error } = await createServiceClient().rpc("intake_unit_for_token", { p_token: token });
  if (error) {
    logError("intake_unit_lookup", error);
    return null;
  }
  return data?.[0] ?? null;
}

export function unitLabel(unit: Pick<IntakeUnit, "address_line1" | "unit_number">): string {
  return unit.unit_number ? `${unit.address_line1}, Unit ${unit.unit_number}` : unit.address_line1;
}

/**
 * When a tenant confirms an email for their account, give that account the
 * tenancies it has proven: same verified email, or a phone-only tenancy this
 * very user (formerly a guest session) confirmed with a code.
 */
export async function claimTenancies(user: User): Promise<void> {
  if (user.is_anonymous || !user.email) return;
  const email = user.email.toLowerCase();
  const service = createServiceClient();
  try {
    await service.from("profiles").update({ email }).eq("id", user.id).is("email", null);

    await service
      .from("tenancies")
      .update({ tenant_user_id: user.id })
      .eq("email", email)
      .not("verified_at", "is", null)
      .is("tenant_user_id", null)
      .is("ended_at", null);

    const { data: verified } = await service
      .from("tenancy_verifications")
      .select("tenancy_id")
      .eq("user_id", user.id);
    const ids = (verified ?? []).map((v) => v.tenancy_id);
    if (ids.length > 0) {
      await service
        .from("tenancies")
        .update({ tenant_user_id: user.id })
        .in("id", ids)
        .is("email", null)
        .is("tenant_user_id", null)
        .is("ended_at", null);
    }
  } catch (err) {
    logError("claim_tenancies", err, { userId: user.id });
  }
}
