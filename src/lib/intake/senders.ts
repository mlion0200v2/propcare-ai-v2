import "server-only";

import { sendEmail } from "@/lib/email/mailer";
import { buildIntakeCodeEmail } from "@/lib/email/templates";
import type { CodeChannel } from "./codes";

export interface CodeMessage {
  code: string;
  workspaceName: string;
  address: string;
}

/**
 * Delivers a one-time code. Email (Resend) today; SMS is a later provider
 * (e.g. Twilio Verify) that only has to implement this interface and be
 * returned from getCodeSender("sms").
 */
export interface CodeSender {
  readonly channel: CodeChannel;
  readonly available: boolean;
  send(destination: string, message: CodeMessage): Promise<{ success: boolean }>;
}

const emailSender: CodeSender = {
  channel: "email",
  available: true,
  async send(destination, message) {
    const mail = buildIntakeCodeEmail(message);
    return sendEmail({ to: destination, ...mail, kind: "intake_code" });
  },
};

const smsNotConfigured: CodeSender = {
  channel: "sms",
  available: false,
  async send() {
    return { success: false };
  },
};

export function getCodeSender(channel: CodeChannel): CodeSender {
  return channel === "email" ? emailSender : smsNotConfigured;
}
