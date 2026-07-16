export function canCreateOrDeleteGroups(role: string | null | undefined) {
  return role === "ADMIN";
}

export function canManageTeamMembership(role: string | null | undefined) {
  return role === "ADMIN" || role === "MODERATOR";
}

export function formatRoleLabel(role: string | null | undefined) {
  switch (role) {
    case "ADMIN":
      return "Admin";
    case "MODERATOR":
      return "Moderator";
    default:
      return "Member";
  }
}
