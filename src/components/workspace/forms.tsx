"use client";

import { useActionState, useState } from "react";
import {
  acceptInvitation,
  createProperty,
  createUnit,
  createWorkspace,
  inviteMember,
  updateWorkspaceSettings,
  type FormState,
} from "@/lib/actions/workspace";

const initial: FormState = { error: null, ok: null };

export const fieldClass =
  "mt-1.5 block w-full border border-line bg-paper px-3 py-2.5 text-[15px] text-ink focus:border-pine focus:outline-none focus:ring-1 focus:ring-pine";
export const primaryButton =
  "bg-pine px-5 py-3 text-sm text-white hover:bg-ink disabled:opacity-60";
export const secondaryButton =
  "min-h-11 border border-line bg-white px-4 py-2.5 text-sm text-ink hover:border-pine";

function Status({ state }: { state: FormState }) {
  if (state.error)
    return (
      <p role="alert" className="text-sm text-brick">
        {state.error}
      </p>
    );
  if (state.ok)
    return (
      <p role="status" className="text-sm text-pine">
        {state.ok}
      </p>
    );
  return null;
}

export function PropertyForm() {
  const [state, action, pending] = useActionState(createProperty, initial);
  return (
    <form action={action} className="grid gap-4 sm:grid-cols-2">
      <label className="text-sm font-medium sm:col-span-2">
        Street address
        <input name="address_line1" required maxLength={200} className={fieldClass} placeholder="3076 Arbutus Street" />
      </label>
      <label className="text-sm font-medium">
        City
        <input name="city" required maxLength={100} defaultValue="Vancouver" className={fieldClass} />
      </label>
      <label className="text-sm font-medium">
        Province
        <input name="province" required maxLength={50} defaultValue="BC" className={fieldClass} />
      </label>
      <label className="text-sm font-medium">
        Postal code
        <input name="postal_code" required maxLength={12} className={fieldClass} placeholder="V6J 3G1" />
      </label>
      <label className="text-sm font-medium">
        Type
        <select name="property_type" defaultValue="multi_unit" className={fieldClass}>
          <option value="single_family">House (one unit)</option>
          <option value="multi_unit">Building with units</option>
          <option value="condo">Condo</option>
          <option value="commercial">Commercial</option>
        </select>
      </label>
      <div className="flex items-center gap-4 sm:col-span-2">
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Adding…" : "Add home"}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function UnitForm({ propertyId }: { propertyId: string }) {
  const [state, action, pending] = useActionState(createUnit, initial);
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="property_id" value={propertyId} />
      <label className="text-sm font-medium">
        Unit number
        <input name="unit_number" maxLength={20} className={fieldClass} placeholder="304" />
      </label>
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "Adding…" : "Add unit"}
      </button>
      <Status state={state} />
    </form>
  );
}

export function InviteForm({
  allowOwners,
  properties,
}: {
  allowOwners: boolean;
  properties: { id: string; label: string }[];
}) {
  const [state, action, pending] = useActionState(inviteMember, initial);
  const [role, setRole] = useState<"manager" | "owner">("manager");
  return (
    <form action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Email
          <input name="email" type="email" required className={fieldClass} />
        </label>
        <label className="text-sm font-medium">
          Role
          <select
            name="role"
            value={role}
            onChange={(e) => setRole(e.target.value as "manager" | "owner")}
            className={fieldClass}
          >
            <option value="manager">Manager (team member)</option>
            {allowOwners && <option value="owner">Property owner</option>}
          </select>
        </label>
      </div>
      {role === "owner" && (
        <fieldset>
          <legend className="text-sm font-medium">Homes this owner will see</legend>
          {properties.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Add a home first.</p>
          ) : (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {properties.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="property_ids" value={p.id} className="accent-pine" />
                  {p.label}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Sending…" : "Send invitation"}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function SettingsForm({ name, approvalLimit, showApproval }: { name: string; approvalLimit: string; showApproval: boolean }) {
  const [state, action, pending] = useActionState(updateWorkspaceSettings, initial);
  return (
    <form action={action} className="max-w-lg space-y-4">
      <label className="block text-sm font-medium">
        Workspace name
        <input name="name" required maxLength={120} defaultValue={name} className={fieldClass} />
      </label>
      <label className={showApproval ? "block text-sm font-medium" : "hidden"}>
        Owner approval needed for quotes over (CAD)
        <input name="approval_limit" inputMode="decimal" defaultValue={approvalLimit} className={fieldClass} />
      </label>
      <div className="flex items-center gap-4">
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Saving…" : "Save"}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState(createWorkspace, initial);
  return (
    <form action={action} className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-semibold">Which describes you?</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="workspace_kind" value="individual" defaultChecked className="accent-pine" />I own rentals
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="workspace_kind" value="company" className="accent-pine" />I manage rentals for owners
        </label>
      </fieldset>
      <label className="block text-sm font-medium">
        Workspace name
        <input name="workspace_name" required maxLength={120} className={fieldClass} />
      </label>
      <div className="flex items-center gap-4">
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? "Creating…" : "Create workspace"}
        </button>
        <Status state={state} />
      </div>
    </form>
  );
}

export function AcceptInviteForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState(acceptInvitation, initial);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "Joining…" : "Join workspace"}
      </button>
      <Status state={state} />
    </form>
  );
}
