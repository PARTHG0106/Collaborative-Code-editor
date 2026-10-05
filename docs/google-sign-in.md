# Google sign-in

SyncScript uses Google Identity Services popup sign-in on the login and
registration pages. The server verifies Google's ID token and a short-lived,
single-use browser challenge before creating a normal SyncScript session.

## Google OAuth client

Use the existing **Web application** client in the `syncscript-510712` project.
Its public client ID is:

```text
570299261681-ovj97q5j44lrvcgsidvrq10fgloop3ns.apps.googleusercontent.com
```

The client's **Authorized JavaScript origins** must include each frontend
origin used for sign-in:

```text
http://localhost
http://localhost:5173
http://localhost:5174
http://localhost:5175
https://parthg0106.dev
https://www.parthg0106.dev
```

Add any separately used Vercel hostname as its exact HTTPS origin. Origins
have no path: do not append `/login` or `/api`. `127.0.0.1` and other ports are
different origins; use the configured `localhost` URLs during development.
Leave **Authorized redirect URIs** empty because this integration uses a popup
and JavaScript callback.

No client secret is needed. Keep the downloaded `client_secret_*.json` outside
Git and Docker builds; the repository ignore rules already exclude it.

## Local and deployed configuration

Set `GOOGLE_CLIENT_ID` to the public ID above in the root `.env` for local
development, and as a variable on the existing Hugging Face Space
`Parthg0106/syncscript-api` for production. Restart the server after changing
it. An unset or empty value hides Google sign-in. The browser obtains the ID
from `/api/auth/google/config`; there is no Google-specific Vite variable.

Keep the browser's frontend origin in the server's `CORS_ORIGINS`. For the
local setup, include the localhost ports actually used. Production must
include `https://parthg0106.dev` and `https://www.parthg0106.dev`, plus any
additional frontend origins used there. Google and server allowlists are
configured separately.

Set the Vercel frontend's build-time `VITE_API_URL=/api`, then rebuild. The
rewrite in `apps/web/vercel.json` forwards API calls to the existing HF Space
while keeping challenge and refresh cookies on the frontend origin. Calling
the HF API directly from the browser instead depends on cross-site cookies,
which browsers may block. Keep `VITE_WS_URL` pointed at the existing backend
for Socket.IO. Locally, set frontend values in `apps/web/.env.local` or the
shell running Vite. `VITE_API_URL=/api` uses Vite's proxy to port 3000;
`http://localhost:3000/api` also works with the matching CORS configuration.

## Migration and release order

Generate the Prisma client and apply committed migrations before starting the
updated server:

```sh
npm run db:generate --workspace=apps/server
npm run db:deploy --workspace=apps/server
```

The `20261005000000_add_google_auth` migration preserves existing users and
password hashes, permits a null password for Google-only accounts, adds a
unique Google subject, and creates the challenge table. See
[database deployment](database-deployment.md) for the preflight checks.
The HF Docker startup script already runs `db:deploy` before serving traffic.
Deploy and verify the backend before releasing the frontend, including the
backend chat acknowledgment support required by the accompanying UX changes.

Verify that `/api/auth/google/config` returns the configured public client ID,
then check Google sign-in on both local and deployed frontend origins. A
successful test should reach the intended workspace or dashboard, survive a
reload, and support sign-out. Use a real Google account for the final popup
check; mocked token tests do not exercise Google's origin or audience settings.

## Account behavior

- An existing verified SyncScript account with a matching Gmail address or
  Google Workspace identity is linked in place. Its app user ID, password,
  workspaces, and memberships are preserved. Email matching is case-insensitive.
- An existing unverified account must first complete password sign-in and
  email verification. Google sign-in does not verify it while retaining an
  unproven password.
- Google accounts using a third-party email address without a Workspace
  identity must use SyncScript's email/password registration and verification,
  or their existing email/password login. This flow does not automatically
  create or link those accounts from Google's email claim.
- A new Gmail or Workspace identity creates a verified Google-only account.
  Once linked, the immutable Google subject identifies the user; a later Google
  email change does not merge accounts or change the stored SyncScript email.
  Conflicting Google links or ambiguous email matches require the original
  sign-in method.
