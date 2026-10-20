import { safeNextPath } from "@/lib/app-url";
import { TenantSignInForm } from "@/components/intake/tenant-sign-in";
import { LoginForm } from "./login-form";

export const metadata = {
  title: "Sign in | PropCare",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string; tenant?: string }>;
}) {
  const { next, error, tenant } = await searchParams;
  const forms = [
    <LoginForm key="team" next={safeNextPath(next) ?? undefined} linkError={error === "link"} />,
    <TenantSignInForm key="tenant" />,
  ];

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md space-y-6">{tenant ? forms.reverse() : forms}</div>
    </div>
  );
}
