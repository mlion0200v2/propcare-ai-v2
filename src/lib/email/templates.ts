/**
 * Plain-text email bodies. Pure functions (no I/O) so they are unit-tested.
 */

export function buildInvitationEmail(params: {
  workspaceName: string;
  inviterName: string;
  role: "manager" | "owner";
  link: string;
  expiresInDays: number;
}): { subject: string; text: string } {
  const { workspaceName, inviterName, role, link, expiresInDays } = params;
  const what =
    role === "owner"
      ? "see maintenance requests and costs for your properties, comment, and approve quotes"
      : "handle maintenance requests with the team";
  return {
    subject: `${inviterName} invited you to ${workspaceName} on PropCare`,
    text: [
      `${inviterName} invited you to join ${workspaceName} on PropCare as ${role === "owner" ? "a property owner" : "a manager"}.`,
      "",
      `You'll be able to ${what}.`,
      "",
      `Accept the invitation: ${link}`,
      "",
      `The link works once and expires in ${expiresInDays} days. If you weren't expecting this, you can ignore this email.`,
    ].join("\n"),
  };
}

export function buildIntakeCodeEmail(params: { code: string; workspaceName: string; address: string }): {
  subject: string;
  text: string;
} {
  return {
    subject: `${params.code} is your PropCare code`,
    text: [
      `Your code to report a problem at ${params.address} is: ${params.code}`,
      "",
      `It expires in 10 minutes. ${params.workspaceName} uses PropCare to handle repair requests.`,
      "If you didn't ask for this code, you can ignore this email.",
    ].join("\n"),
  };
}

export function buildTenantReplyEmail(params: {
  workspaceName: string;
  authorName: string;
  ticketTitle: string;
  body: string;
  link: string | null;
}): { subject: string; text: string } {
  return {
    subject: `Update on your request: ${params.ticketTitle.slice(0, 80)}`,
    text: [
      `${params.authorName} (${params.workspaceName}) wrote:`,
      "",
      params.body,
      "",
      params.link ? `See your request: ${params.link}` : null,
      "",
      "Reply by adding a message to your request. Emergencies: call 911.",
    ]
      .filter((l) => l !== null)
      .join("\n"),
  };
}
