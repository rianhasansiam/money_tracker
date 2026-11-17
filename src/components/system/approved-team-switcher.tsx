import { getApprovedTeamNavigation } from "@/lib/queries/teams";
import { TeamSwitcher } from "@/components/system/team-switcher";
import { reportUnexpectedError, SERVER_ERROR_CATEGORY } from "@/lib/observability";

/** User identity is consumed on the server; only approved-team DTOs cross to the client. */
export async function ApprovedTeamSwitcher({ userId, activeTeamId }: { userId: string; activeTeamId?: string }) {
  let navigation: Awaited<ReturnType<typeof getApprovedTeamNavigation>> = null;
  let unavailable = false;
  try {
    navigation = await getApprovedTeamNavigation(userId, activeTeamId);
  } catch (error) {
    reportUnexpectedError(error, { category: SERVER_ERROR_CATEGORY.dataAccess, context: { operation: "initial_team_navigation" } });
    unavailable = true;
  }
  if (unavailable) return <p className="text-xs text-muted-foreground">Team switcher unavailable. Use Teams to choose a workspace.</p>;
  if (!navigation) return null;
  return <TeamSwitcher key={navigation.scope} initialPage={navigation.page} activeTeam={navigation.activeTeam} />;
}
