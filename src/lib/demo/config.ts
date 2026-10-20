/**
 * Try mode ("skip to the fun part"): /try creates a private sample workspace
 * per browser. Off unless DEMO_MODE=1.
 */
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === "1";
}

/** httpOnly cookie holding this browser's sandbox id (an unguessable UUID). */
export const DEMO_COOKIE = "pc_demo";

/** Chat turns (each may call OpenAI) per sandbox, shared by all its roles. */
export function demoChatTurnLimit(): number {
  const n = Number(process.env.DEMO_CHAT_TURN_LIMIT);
  return Number.isInteger(n) && n > 0 ? n : 40;
}

/** Upper bound on live sandboxes, so the demo can't fill the database. */
export const MAX_LIVE_SANDBOXES = 500;

export type DemoRole = "tenant" | "manager" | "owner" | "vendor";
export const DEMO_ROLES: readonly DemoRole[] = ["tenant", "manager", "owner", "vendor"];

/** Where the role switcher sends you, keeping the same ticket in view. */
export function demoDestination(
  role: DemoRole,
  ticket: { id: string; ownerCanSee: boolean; tenantCanSee: boolean; vendorToken: string | null } | null
): string {
  switch (role) {
    case "manager":
      return ticket ? `/tickets/${ticket.id}` : "/dashboard";
    case "owner":
      return ticket?.ownerCanSee ? `/tickets/${ticket.id}` : "/dashboard";
    case "tenant":
      return ticket?.tenantCanSee ? `/my-requests/${ticket.id}` : "/my-requests";
    case "vendor":
      return ticket?.vendorToken ? `/v/${ticket.vendorToken}` : "/dashboard";
  }
}

/** The ticket the current page is about, if any (/tickets/<id>, /my-requests/<id>). */
export function ticketIdFromPath(pathname: string): string | null {
  const m = /^\/(?:tickets|my-requests)\/([0-9a-f-]{36})(?:\/|$)/i.exec(pathname);
  return m ? m[1] : null;
}

export function vendorTokenFromPath(pathname: string): string | null {
  const m = /^\/v\/([A-Za-z0-9]{32,128})(?:\/|$)/.exec(pathname);
  return m ? m[1] : null;
}
