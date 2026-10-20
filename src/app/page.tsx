import { redirect } from "next/navigation";
import { getSessionUser, homePathForUser } from "@/lib/workspace/server";

export default async function Home() {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login");
  }

  redirect(await homePathForUser());
}
