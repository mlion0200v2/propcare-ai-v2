import { TriageChat } from "@/components/triage/chat";

export const metadata = {
  title: "Submit Issue | MaintenanceWise",
};

export default function SubmitPage() {
  return (
    <div className="h-[calc(100vh-57px)]">
      <TriageChat />
    </div>
  );
}
