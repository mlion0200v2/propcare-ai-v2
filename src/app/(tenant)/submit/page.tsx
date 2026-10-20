import { redirect } from "next/navigation";

// Requests now start from the unit's link (/r/<token>); signed-in tenants
// find theirs on /my-requests.
export default function SubmitPage() {
  redirect("/my-requests");
}
