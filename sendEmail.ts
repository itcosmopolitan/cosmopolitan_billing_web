import fs from 'fs';
import path from 'path';
import { Resend } from 'resend';

export type EmailType = 'onboarding' | 'forgot-password';

export interface SendEmailOptions {
  emailType: EmailType;
  to: string;
  variables: Record<string, string | undefined>;
  fromEmail?: string;
  resendApiKey?: string;
}

export class EmailTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailTemplateError';
  }
}

const REQUIRED_VARIABLES: Record<EmailType, string[]> = {
  onboarding: ['first_name', 'user_email', 'temporary_password', 'login_url', 'expiry_hours', 'help_center_url', 'current_year'],
  'forgot-password': ['first_name', 'reset_url', 'expiry_minutes', 'help_center_url', 'current_year'],
};

const SUBJECTS: Record<EmailType, string> = {
  onboarding: 'Welcome to Cosmopolitan — your account is ready',
  'forgot-password': 'Cosmopolitan — reset your password',
};

function ensureRequiredVariables(emailType: EmailType, variables: Record<string, string | undefined>) {
  const missing = REQUIRED_VARIABLES[emailType].filter((key) => {
    const value = variables[key];
    return value === undefined || value === null || value.trim() === '';
  });

  if (missing.length > 0) {
    throw new EmailTemplateError(`Missing required variables for ${emailType}: ${missing.join(', ')}`);
  }
}

function applyTemplateVariables(template: string, variables: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined || value === null) {
      return '';
    }
    return value;
  });
}

function readTemplate(emailType: EmailType): string {
  const templatePath = path.resolve(__dirname, emailType === 'onboarding' ? 'onboarding-email.html' : 'forgot-password-email.html');
  return fs.readFileSync(templatePath, 'utf8');
}

function buildEmailHtml(emailType: EmailType, variables: Record<string, string | undefined>): string {
  const templateContent = readTemplate(emailType);
  return applyTemplateVariables(templateContent, variables);
}

export async function sendEmail(options: SendEmailOptions) {
  const { emailType, to, variables, fromEmail = 'it@cosmopolitan.com.mv', resendApiKey = process.env.RESEND_API_KEY } = options;

  ensureRequiredVariables(emailType, variables);

  const html = buildEmailHtml(emailType, variables);
  const resend = new Resend(resendApiKey);

  return resend.emails.send({
    from: fromEmail,
    to: [to],
    subject: SUBJECTS[emailType],
    html,
  });
}
