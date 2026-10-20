import { isDemoMode } from "@/lib/demo/config";
import { getSandbox, roleOfUser } from "@/lib/demo/server";
import { getSessionUser } from "@/lib/workspace/server";
import { DemoBar } from "./demo-bar";

function hoursUntil(iso: string): number {
  return Math.max(1, Math.ceil((new Date(iso).getTime() - Date.now()) / 3_600_000));
}

/** Renders the demo bar only for a browser inside a live sandbox. */
export async function DemoBarSlot() {
  if (!isDemoMode()) return null;
  const sandbox = await getSandbox();
  if (!sandbox) return null;
  const user = await getSessionUser();
  return <DemoBar role={roleOfUser(sandbox, user?.id)} hoursLeft={hoursUntil(sandbox.expires_at)} />;
}
