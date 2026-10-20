import { requireAdmin } from "@/lib/workspace/server";
import { SettingsForm } from "@/components/workspace/forms";

export const metadata = {
  title: "Settings | PropCare",
};

export default async function SettingsPage() {
  const membership = await requireAdmin();
  const company = membership.kind === "company";

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-[34px] leading-tight">Settings</h1>
        <p className="mt-2 max-w-2xl text-[15px] text-muted">
          {company
            ? "Quotes above the approval limit wait for the property owner before work is booked."
            : "Workspace details."}
        </p>
      </div>
      <section className="border border-line bg-white p-6 sm:p-7">
        <SettingsForm
          name={membership.workspaceName}
          approvalLimit={(membership.approvalLimitCents / 100).toFixed(0)}
          showApproval={company}
        />
      </section>
    </div>
  );
}
