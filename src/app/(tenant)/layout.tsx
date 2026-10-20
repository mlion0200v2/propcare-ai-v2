import { signOut } from "@/lib/actions/auth";

export default function TenantLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-paper font-brand text-ink">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <p className="font-display text-xl text-pine">PropCare</p>
          <form action={signOut}>
            <button type="submit" className="text-sm text-muted hover:text-ink">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-3xl">{children}</main>
    </div>
  );
}
