import Link from "next/link";
import { createServiceClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/workspace/server";
import { hashToken } from "@/lib/workspace/tokens";
import { AcceptInviteForm } from "@/components/workspace/forms";

export const metadata = {
  title: "Invitation | PropCare",
};

export const dynamic = "force-dynamic";

function isLive(inv: { accepted_at: string | null; revoked_at: string | null; expires_at: string }): boolean {
  return !inv.accepted_at && !inv.revoked_at && new Date(inv.expires_at).getTime() > Date.now();
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}${"•".repeat(Math.max(local.length - 1, 2))}@${domain}`;
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = /^[A-Za-z0-9_-]{16,64}$/.test(token);

  // The invitee is not a member yet, so RLS can't show them the invitation;
  // look it up by the hash of the secret token with the service role.
  const { data: invitation } = valid
    ? await createServiceClient()
        .from("invitations")
        .select("email, role, expires_at, accepted_at, revoked_at, workspaces(name)")
        .eq("token_hash", hashToken(token))
        .maybeSingle()
    : { data: null };

  const live = invitation && isLive(invitation);

  const user = live ? await getSessionUser() : null;
  const signedInAs = user && !user.is_anonymous ? user.email?.toLowerCase() : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4 font-brand text-ink">
      <div className="w-full max-w-md space-y-5 border border-line bg-white p-8">
        <p className="font-display text-xl text-pine">PropCare</p>
        {!live ? (
          <>
            <h1 className="font-display text-3xl">This invitation can&apos;t be used</h1>
            <p className="text-[15px] text-muted">
              It may have expired, been used already, or been withdrawn. Ask the person who invited you to send a new one.
            </p>
          </>
        ) : (
          <>
            <h1 className="font-display text-3xl">Join {invitation.workspaces?.name}</h1>
            <p className="text-[15px] text-muted">
              You were invited as {invitation.role === "owner" ? "a property owner" : "a manager"}. The invitation was sent
              to {maskEmail(invitation.email)}.
            </p>
            {signedInAs === invitation.email ? (
              <AcceptInviteForm token={token} />
            ) : signedInAs ? (
              <p role="alert" className="text-sm text-brick">
                You&apos;re signed in as {signedInAs}. Sign out and sign in with the invited address to accept.
              </p>
            ) : (
              <div className="flex flex-wrap gap-3">
                <Link
                  href={`/signup?invite=${encodeURIComponent(token)}`}
                  className="bg-pine px-5 py-3 text-sm text-white hover:bg-ink"
                >
                  Create an account
                </Link>
                <Link
                  href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}
                  className="border border-line px-5 py-3 text-sm hover:border-pine"
                >
                  I already have one
                </Link>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
