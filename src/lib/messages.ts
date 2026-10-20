/**
 * Outgoing message texts and share links. Pure functions (tested).
 *
 * WhatsApp/WeChat today: the manager's own app sends the message —
 * "Send via WhatsApp" opens wa.me with the text prefilled, "Copy for WeChat"
 * copies it. A WhatsApp Business API integration can replace this later.
 */

export function buildVendorWorkOrderMessage(params: {
  workspaceName: string;
  vendorName: string;
  title: string;
  address: string;
  link: string;
}): { subject: string; text: string } {
  return {
    subject: `Work order: ${params.title} at ${params.address}`.slice(0, 200),
    text: [
      `Hi ${params.vendorName}, ${params.workspaceName} has a job for you:`,
      `${params.title}, ${params.address}.`,
      "",
      `Details, photos, access and a quote form (no account needed): ${params.link}`,
    ].join("\n"),
  };
}

/** wa.me link with prefilled text; `phone` (any format) targets a contact. */
export function whatsappLink(text: string, phone?: string | null): string {
  const digits = (phone ?? "").replace(/\D/g, "");
  const target = digits.length === 10 ? `1${digits}` : digits;
  return `https://wa.me/${target}?text=${encodeURIComponent(text)}`;
}
