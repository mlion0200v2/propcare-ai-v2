import { redirect } from "next/navigation";
import { createClient, getProfileRole } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const role = await getProfileRole(supabase, user.id);
  redirect(role === "manager" ? "/dashboard" : "/submit");
}
