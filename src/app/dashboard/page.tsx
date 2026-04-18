import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getFirstApprovedTeamId } from "@/lib/queries/groups";

export const metadata = {
  title: "Dashboard",
};

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const firstApprovedTeamId = await getFirstApprovedTeamId(session.user.id);

  redirect(firstApprovedTeamId ? `/dashboard/${firstApprovedTeamId}` : "/groups");
}
