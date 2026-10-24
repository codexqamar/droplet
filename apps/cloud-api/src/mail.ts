import nodemailer from "nodemailer";
import { config } from "./config.js";

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Transport seam: SMTP when SMTP_URL is set (Postmark, SES, Resend, Mailgun, Microsoft 365 ...),
 * otherwise the server log (development and demos).
 * Security mail must come from a DKIM/DMARC-aligned domain so users can trust the recovery link.
 */
export type MailTransport = (msg: OutboundEmail) => Promise<void>;

const logTransport: MailTransport = async (msg) => {
  console.info(`[mail] to=${msg.to} subject="${msg.subject}"\n${msg.text}`);
};

function smtpTransport(url: string, from: string): MailTransport {
  const mailer = nodemailer.createTransport(url);
  return async (msg) => {
    await mailer.sendMail({ from, to: msg.to, subject: msg.subject, text: msg.text });
  };
}

let transport: MailTransport = config.smtpUrl ? smtpTransport(config.smtpUrl, config.mailFrom || "DROPLET <no-reply@localhost>") : logTransport;

/** Shown in the admin portal under Integrations. */
export function mailStatus(): { mode: "smtp" | "log"; from: string | null; host: string | null } {
  if (!config.smtpUrl) return { mode: "log", from: null, host: null };
  let host: string | null = null;
  try {
    host = new URL(config.smtpUrl).hostname;
  } catch {
    /* not a URL; leave blank */
  }
  return { mode: "smtp", from: config.mailFrom || null, host };
}

export const setMailTransport = (t: MailTransport): void => {
  transport = t;
};

export const sendMail = (msg: OutboundEmail): Promise<void> => transport(msg);

export function tamperAlertEmail(args: {
  to: string;
  fullName: string;
  accountCode: string;
  deviceLabel: string;
  detectedAt: Date;
  mismatchCount: number;
  recoveryToken: string;
  expiresAt: Date;
}): OutboundEmail {
  const link = `${config.portalOrigin}/security/recover?token=${encodeURIComponent(args.recoveryToken)}`;
  return {
    to: args.to,
    subject: `[DROPLET] Security lock on account ${args.accountCode}: desktop app modification detected`,
    text: [
      `Hello ${args.fullName},`,
      ``,
      `At ${args.detectedAt.toISOString()} the DROPLET desktop app on "${args.deviceLabel}" reported that`,
      `${args.mismatchCount} of its signed program files did not match the published release.`,
      `This can mean the software was modified or that malware is present on that machine.`,
      ``,
      `As a precaution we have:`,
      `  • locked trade account ${args.accountCode} (portal, ordering and desktop sync are paused)`,
      `  • signed out every active session`,
      `  • quarantined the affected device`,
      ``,
      `To restore access, open the link below, sign in with your password and complete MFA.`,
      `The link works once and expires at ${args.expiresAt.toISOString()}.`,
      ``,
      `  ${link}`,
      ``,
      `After verification the affected device's certificate is revoked and you will receive a`,
      `freshly signed installer. Uninstall the old app, ideally scan the machine, then install the`,
      `new build. The account unlocks automatically once the clean install checks in.`,
      ``,
      `If you did not expect this, contact your DROPLET account manager. DROPLET will never ask`,
      `for your password or MFA code by email or phone.`,
    ].join("\n"),
  };
}
