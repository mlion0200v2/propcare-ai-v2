import "server-only";

import { Resend } from "resend";
import { logError, logWarn } from "@/lib/logger";
import { isReservedAddress } from "./reserved";

let _resend: Resend | null = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

/** Sender for account emails (invites, codes, replies). Must be a verified Resend domain. */
export function emailFrom(): string {
  return process.env.EMAIL_FROM || "PropCare-AI <noreply@simoneliu.com>";
}

/**
 * Emails are only sent when RESEND_API_KEY is set and EMAIL_DRY_RUN is not
 * "1". In dry-run the message is logged (without the body) instead, so local
 * and CI runs never reach a real inbox.
 */
export function isEmailDryRun(): boolean {
  return process.env.EMAIL_DRY_RUN === "1" || !process.env.RESEND_API_KEY;
}

export async function sendEmail(params: {
  to: string | string[];
  subject: string;
  text: string;
  /** For logs only. */
  kind: string;
}): Promise<{ success: boolean; error?: string }> {
  const { to, subject, text, kind } = params;
  // Reserved example domains (demo and test users) are never delivered.
  if ((Array.isArray(to) ? to : [to]).every((addr) => isReservedAddress(addr))) {
    logWarn("email_reserved_domain", "Email to a reserved example domain not sent", { kind });
    return { success: true };
  }
  if (isEmailDryRun()) {
    logWarn("email_dry_run", "Email not sent (dry run)", { kind, to, subject });
    if (process.env.NODE_ENV !== "production") {
      // Lets a developer finish a flow (e.g. read a one-time code) locally.
      console.log(`\n[email dry run] to=${String(to)} subject=${subject}\n${text}\n`);
    }
    return { success: true };
  }
  try {
    const { error } = await getResend().emails.send({ from: emailFrom(), to, subject, text });
    if (error) {
      logError("email_send", error, { kind });
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err) {
    logError("email_send", err, { kind });
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
