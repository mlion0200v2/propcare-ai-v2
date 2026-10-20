import { safeNextPath } from "@/lib/app-url";
import { LoginForm } from "./login-form";

export const metadata = {
  title: "Sign in | PropCare",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md space-y-6">
        <LoginForm next={safeNextPath(next) ?? undefined} linkError={error === "link"} />
      </div>
    </div>
  );
}
