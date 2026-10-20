export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Each page lays itself out (sign-up is a full-width two-column page).
  return <div className="min-h-screen bg-paper font-brand text-ink">{children}</div>;
}
