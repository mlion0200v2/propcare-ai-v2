import { redirect } from "next/navigation";
import { getActiveMembership, getSessionUser } from "@/lib/workspace/server";
import { CreateWorkspaceForm } from "@/components/workspace/forms";

export const metadata = {
  title: "Create your workspace | PropCare",
};

export const dynamic = "force-dynamic";

/** Signed-in, confirmed user with no workspace yet. */
export default async function WelcomePage() {
  const user = await getSessionUser();
  if (!user || user.is_anonymous) redirect("/login");
  if (await getActiveMembership()) redirect("/dashboard");

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4 font-brand text-ink">
      <div className="w-full max-w-md space-y-6 border border-line bg-white p-8">
        <div>
          <h1 className="font-display text-3xl">Create your workspace</h1>
          <p className="mt-2 text-[15px] text-muted">
            You&apos;re signed in as {user.email}. If you were invited to a team, open the link in that email instead.
          </p>
        </div>
        <CreateWorkspaceForm />
      </div>
    </div>
  );
}
