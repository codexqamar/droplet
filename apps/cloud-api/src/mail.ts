import { config } from "./config.js";

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Transport seam. Production binds this to SES/Postmark; dev logs to stdout.
 * Security mail must come from a DKIM/DMARC-aligned domain so users can trust the recovery link.
 */
export type MailTransport = (msg: OutboundEmail) => Promise<void>;

let transport: MailTransport = async (msg) => {
  console.info(`[mail] to=${msg.to} subject="${msg.subject}"\n${msg.text}`);
};

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
