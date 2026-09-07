import type { DirectoryRole } from "@workspace/api-client-react";

export function roleLabel(role: DirectoryRole): string {
  return role === "unsuffixed"
    ? "Group"
    : `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

export function roleBadgeClass(role: DirectoryRole): string {
  switch (role) {
    case "admin":
      return "bg-amber-100 text-amber-800 border-amber-300";
    case "member":
      return "bg-cyan-100 text-cyan-800 border-cyan-300";
    case "viewer":
      return "bg-slate-100 text-slate-600 border-slate-300";
    default:
      return "bg-slate-100 text-slate-500 border-slate-200";
  }
}