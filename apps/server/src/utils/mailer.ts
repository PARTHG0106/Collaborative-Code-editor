import nodemailer from 'nodemailer';
import axios from 'axios';

interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

// SMTP credentials can be set in environment variables
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || 'no-reply@collabedit.com';

let transporter: nodemailer.Transporter | null = null;

// Determine if we should use Brevo REST API (using an API key)
const isBrevoApi = !!(SMTP_PASS && SMTP_PASS.startsWith('xkeysib-'));

if (isBrevoApi) {
  console.info('📧 Mailer configured to use Brevo REST API');
} else if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // true for 465, false for other ports
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
  console.info(`📧 Mailer configured with SMTP Host: ${SMTP_HOST}`);
} else {
  console.info('📧 Mailer running in development/mock mode (will print emails to console)');
}

/**
 * Sends a verification email. Falls back to console log in development/local test.
 */
export async function sendEmail({ to, subject, text, html }: MailOptions): Promise<boolean> {
  if (isBrevoApi && SMTP_PASS) {
    try {
      await axios.post(
        'https://api.brevo.com/v3/smtp/email',
        {
          sender: {
            name: 'Collab Team',
            email: SMTP_FROM,
          },
          to: [
            {
              email: to,
            },
          ],
          subject,
          htmlContent: html || text.replace(/\n/g, '<br>'),
          textContent: text,
        },
        {
          headers: {
            'accept': 'application/json',
            'api-key': SMTP_PASS,
            'content-type': 'application/json',
          },
        }
      );
      return true;
    } catch (err: any) {
      console.error(`Failed to send email to ${to} via Brevo REST API:`, err.response?.data || err);
      // Fall back to console logging so that application flow is not broken
    }
  } else if (transporter) {
    try {
      await transporter.sendMail({
        from: SMTP_FROM,
        to,
        subject,
        text,
        html: html || text.replace(/\n/g, '<br>'),
      });
      return true;
    } catch (err) {
      console.error(`Failed to send email to ${to} via SMTP:`, err);
      // Fall back to console logging so that application flow is not broken
    }
  }

  // Fallback / Development Mock output
  console.info('\n=================== MOCK EMAIL ===================');
  console.info(`FROM: ${SMTP_FROM}`);
  console.info(`TO: ${to}`);
  console.info(`SUBJECT: ${subject}`);
  console.info(`CONTENT:`);
  console.info(text);
  console.info('==================================================\n');
  return true;
}
