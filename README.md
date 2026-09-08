# Gather CRM

A visiting-card capture and workspace-based Gmail outreach application, available locally and at [gather-crm.vercel.app](https://gather-crm.vercel.app). See [Vercel deployment details](VERCEL-DEPLOYMENT.md) for cloud configuration and operating limits. The reference CRM remains untouched at `/Users/rounak/Downloads/crm`.

## Run

Requires Node.js 22 or newer. No package installation is needed.

```sh
npm start
```

Open http://localhost:3088. The page opens on **Sign in**, with a separate **Create account** tab and **Continue with Google** button. On first launch, create the owner account with your name, email, and a password of at least 12 characters, or continue with Google once the application OAuth client is configured. Opening `index.html` directly only shows a link to the local server.

## Authentication

Registration stays open after the first account is created. The original account remains the superadmin with its existing CRM data. Each additional email/password or Google account starts with separate workspaces, contacts, uploaded images, templates, campaigns, LLM settings, and Google connections. Registration never grants access to the superadmin's data. The role is assigned by the server; it cannot be chosen during sign-up. Email/password addresses are login identifiers, not verified Google identities. Connect Gmail and Sheets separately after signing in.

Existing owner records and sessions migrate automatically. Local member data is stored under `data/accounts/<user-id>/`; hosted records use the same account prefix in the encrypted database. Password changes revoke only that account's sessions, and failed password attempts are limited per email. A new Google identity creates a separate account. To use Google for an existing password account, sign in with the password and choose **Link Google account** from the account menu.

**Google login:** the server uses an authorization code flow with PKCE, a single-use state and a browser-bound cookie. It retrieves the verified Google identity directly from Google's authenticated userinfo endpoint and stores the stable `sub` identifier. Google authentication tokens are discarded after login; it does not connect Gmail or Sheets or request their permissions. The first account in a new local installation becomes the superadmin; subsequent Google registrations create members. Existing password owners first sign in with their password, click their name in the top bar, and select **Link Google account**. Matching an email alone does not link accounts or grant access. A different Google identity starts its own account and cannot access another account’s data. See Google's [OpenID Connect reference](https://developers.google.com/identity/openid-connect/reference).

The server requires a valid session for every CRM API, uploaded image, and Google OAuth callback. Passwords use salted scrypt hashes (N=131072, r=8, p=1). Random session tokens are stored in HttpOnly, SameSite=Lax cookies; only their SHA-256 hashes are persisted on the server. Sessions expire after seven days, survive server restarts, and are revoked on sign-out. Ten failed password attempts within 15 minutes temporarily block further attempts. Authentication writes retain the app's same-origin/custom-header checks, and Google connection state is bound to the login that started it.

Click your name in the top bar to change your password. This requires the current password and revokes all previous sessions. A Google-only account can set its first password within ten minutes of a Google sign-in. **Sign out** is available on every CRM page. The account is stored in `data/auth.json` with owner-only file permissions. Back it up with the rest of `data/`. There is no email-based password recovery or public registration in this local build; keep your password in your password manager.

## Product sections

- **Workspaces:** create occasions/projects, each with exactly one Google spreadsheet. Create a spreadsheet or connect an existing URL/ID. The app uses a dedicated `Gather Contacts` tab and leaves other tabs alone.
- **Contacts:** manually add/edit all emails and phones, choose recipients, exclude individual addresses from campaigns, copy contacts between workspaces, import an existing sheet tab with column mapping, and automatically sync approved contacts.
- **Upload cards:** choose the destination workspace and upload up to 20 JPEG/PNG/WebP photos. Once a model and provider key are configured, AI reads and approves valid cards automatically, then syncs them to the workspace spreadsheet. Cards uploaded before setup wait and start after AI is enabled. Keep Gather open while the queue runs; untouched queued cards resume on return. Provider failures and invalid or insufficient extracted details remain available for manual attention.
- **Duplicate handling:** automatically extracted cards with one matching email or phone contact merge into that contact; addresses, numbers and notes are combined. Ambiguous matches remain separate so one existing contact is not chosen arbitrarily. Manually imported or copied rows retain the review flow.
- **Templates:** separate workspace-scoped editor, saved templates, subject, message, personalization fields, real image uploads and email preview.
- **Communication:** select a workspace template and recipients, create a frozen draft, preview it, then explicitly send. Each distinct address gets one message with inline images. Actual Gmail IDs, timestamps, sender and per-recipient status are retained.
- **Connections:** separate Google sign-in buttons for Gmail and Sheets. End users do not enter Google API keys. States reflect stored OAuth connections; no simulated success.
- **Settings:** extraction toggle, provider, model dropdown, encrypted provider key, compatible-provider base URL, and a saved-configuration test. Gemini's documented card-reading model choices are visible immediately without an API key. This bundled catalog is not a guarantee of account access. Enter a key and use Refresh list to fetch the account-specific list, including pagination; saved keys refresh automatically. Listing models does not save or change credentials, and a failed refresh keeps the visible choices. Gemini models without `generateContent` support remain visible in live results but cannot be selected for extraction; other models still need to support image input. The Base URL field is shown only for compatible providers.

## One-time Google application setup

Copy `.env.example` to `.env`, then fill in a Google **Web application** OAuth client ID and secret. Enable Gmail API and Google Sheets API in that Google Cloud project for the connectors. Register both exact redirect URIs on the same OAuth client:

```
http://localhost:3088/api/oauth/google/callback
http://localhost:3088/api/auth/google/callback
```

The first URI serves Gmail/Sheets connections; the second serves Gather login (`GOOGLE_LOGIN_REDIRECT_URI`). Restart the server to enable **Continue with Google**. Without the client ID and secret, the button explains that application setup is needed, and email/password login remains available. End users never enter Google API keys.

After signing in, open Connections and connect both services. They may use different Google accounts. Gmail asks for sending access; Sheets asks for spreadsheet read/write access. The API client uses OAuth access and refresh tokens. Google verification/testing restrictions depend on the OAuth app's publishing status.

API credentials for Gemini or a compatible vision provider are entered in Settings. Choose a model from the provider's live list rather than typing its ID. Compatible base URLs must end at the API root (for example `/v1`); the app adds `/models` for discovery and `/chat/completions` for extraction. Changing providers/endpoints clears the previous key so it is not sent to a different service by accident.

## Data and sync

Workspace data and image files are persisted in the ignored `data/` directory. OAuth refresh tokens and LLM keys are encrypted with an installation key stored in `data/.secret-key`, with file permissions restricted to the local user. Back up the entire directory together. Secrets are omitted from the browser state API and never written to browser storage.

New and edited contacts, including approved card scans and duplicate merges, sync immediately to their workspace’s linked spreadsheet after the contact is durably saved. Linking a spreadsheet also syncs existing workspace contacts. Unapproved cards stay in review. If Sheets fails or the account is disconnected, the saved contact remains pending with a visible error and Retry sync action. The next contact save also retries pending changes in that workspace. Refresh from sheet imports edits made directly in Google Sheets; there is no background polling.

Sync uses a stable Gather ID in column A. Locally edited contacts take precedence; otherwise spreadsheet edits are imported. New rows are appended using RAW values (not formulas). Sync is additive: it does not delete local contacts when a spreadsheet row disappears. The connected spreadsheet is synced before a campaign draft freezes its recipient list. Template changes after that point do not alter the draft.

This build is bound to localhost and intended for one authenticated owner. It is not a public multi-user deployment. A hosted release needs HTTPS with Secure cookies, account-scoped data and connection ownership, verified account recovery, shared transactional storage, and a durable background queue. The reference CRM's Firebase identity model can be used for that phase.

## Bulk email

Click **Send bulk email** on Overview or Communication to refresh the workspace’s Gather Contacts sheet and load every eligible address. Choose a saved template, save the draft, then confirm the sender, message, and final recipient count with **Confirm & send**. Bulk mode includes fresh sheet rows even when an older contact selection exists; duplicate and excluded addresses are skipped. The sender is the connected Gmail account.

## Delivery behavior and limits

- At most 100 unique addresses per campaign, processed sequentially with a short interval. Gmail account quotas still apply.
- Gmail must return a message ID before a recipient is marked sent. This confirms submission, not inbox placement or reading.
- A failed or ambiguous send stops the campaign. Unattempted recipients remain pending. There is no automatic retry that could duplicate an ambiguous send.
- A server interruption during submission marks that recipient unknown on restart. Check Gmail Sent before creating a replacement campaign. Submitted campaigns cannot be re-submitted.
- Sender names on a visiting card are not assumed to own every email address. Personalization defaults to the business team or a generic greeting.
- This build supports one connected Gmail account and one Sheets account at a time. Workspace sheets retain their owning Google account identity.

## Verification

```sh
npm run check
npm test
```

Tests use isolated temporary installations and mocked Google/LLM responses. They cover account setup, separate-account registration, login, session rotation/expiry, sign-out, password changes, authentication enforcement, rate limiting, extraction, persistence, workspace isolation, multi-address contacts, merge review, credential redaction, OAuth browser/session binding, Sheets synchronization, image MIME messages, send confirmation, deduplication, and uncertain-delivery handling. They do not send real emails or create real spreadsheets.

The original browser-only script is retained as `app.v1.backup.js`. Old localStorage data is not overwritten; Settings offers an explicit migration when the new installation is empty. Mock connection claims and historical sending counts are not imported.

Automatic extraction uses one request per queued card. Successful cards are approved automatically and are not re-read. AI-completed cards left in review by an older release are approved once on the next refresh without another model request. Provider errors, interrupted readings, and invalid or insufficient data require attention. Approval never sends email; campaigns still require an explicit final confirmation.
