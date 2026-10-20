/**
 * Health check for Cloud Run's startup probe, the deploy smoke test and the
 * uptime check. Reports only whether each dependency is configured (never the
 * values) and the deployed version.
 */
export const dynamic = "force-dynamic";

export function GET() {
  const configured = (name: string) => Boolean(process.env[name]);
  return Response.json(
    {
      ok: true,
      version: process.env.APP_VERSION ?? "dev",
      configured: {
        supabase:
          configured("NEXT_PUBLIC_SUPABASE_URL") &&
          configured("SUPABASE_SERVICE_ROLE_KEY"),
        openai: configured("OPENAI_API_KEY"),
        pinecone: configured("PINECONE_API_KEY"),
        email: configured("RESEND_API_KEY") && process.env.EMAIL_DRY_RUN !== "1",
        demo: process.env.DEMO_MODE === "1",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
