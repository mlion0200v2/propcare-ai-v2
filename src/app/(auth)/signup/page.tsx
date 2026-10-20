import { SignUpForm } from "./signup-form";

export const metadata = {
  title: "Sign up | PropCare",
};

export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<{ invite?: string; email?: string }>;
}) {
  const { invite, email } = await searchParams;
  const inviteToken = typeof invite === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(invite) ? invite : undefined;

  return (
    <div className="grid min-h-screen lg:grid-cols-[5fr_7fr]">
      <aside className="flex flex-col justify-between gap-10 bg-pine p-8 text-white sm:p-16">
        <div>
          <p className="font-display text-[22px] tracking-[2px] text-gold">PropCare</p>
          <p className="mt-2 text-xs uppercase tracking-[1.5px] text-[#cad7cf]">by Birchwood Management</p>
          <h1 className="mt-12 font-display text-4xl leading-tight sm:mt-16 sm:text-[44px]">
            A maintenance desk that never sleeps, for your rentals.
          </h1>
          <ul className="mt-8 list-disc space-y-2 pl-5 text-base text-[#e0e5d9]">
            <li>Tenants report through a link. No app, no password.</li>
            <li>Danger checked first; emergencies go to your phone.</li>
            <li>Tickets arrive with photos and what was tried.</li>
          </ul>
        </div>
      </aside>
      <section className="flex flex-col justify-center px-4 py-12 sm:px-12 lg:px-24">
        <SignUpForm invite={inviteToken} inviteEmail={typeof email === "string" ? email : undefined} />
      </section>
    </div>
  );
}
