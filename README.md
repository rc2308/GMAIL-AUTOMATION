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

- **Workspaces:** create occasions/projects, each with exactly one Google spreadsheet. Choose **Link existing spreadsheet** on a workspace card, or link a sheet while creating a workspace by pasting its Google Sheets URL/ID. Linking opens a contact import step: enter the source tab name and match its first-row column headers to bring existing emails and phone numbers into review. You can skip this step and use **Import contacts** on the workspace card later. Creating a new spreadsheet or setting one up later is also available. Connect Google Sheets first, using an account that can edit the spreadsheet. Approved contacts sync to a dedicated `Gather Contacts` tab; original tabs stay unchanged.
- **Contacts:** manually add/edit all emails and phones, choose recipients, exclude individual addresses from campaigns, copy contacts between workspaces, import an existing sheet tab with column mapping, and automatically sync approved contacts.
- **Upload cards:** choose the destination workspace and upload up to 40 JPEG/PNG/WebP photos. Once a model and provider key are configured, AI reads and approves valid cards automatically, then syncs them to the workspace spreadsheet. Cards uploaded before setup wait and start after AI is enabled. Keep Gather open while the queue runs. Cards are processed in groups of 10, with one automatic retry for failed reads in each group. Queued cards and an unused retry resume on return; exhausted retries and invalid or insufficient details remain available for manual attention. After the contact is durably saved, its card image is removed from backend storage. Failed cards keep their images.
- **Duplicate handling:** automatically extracted cards with one matching email or phone contact merge into that contact; addresses, numbers and notes are combined. Ambiguous matches remain separate so one existing contact is not chosen arbitrarily. Manually imported or copied rows retain the review flow.
- **Templates:** separate workspace-scoped editor, saved templates, subject, message, personalization fields, real image uploads and email preview.
- **Communication:** select a workspace template and recipients, create a frozen draft, preview it, then explicitly send. Each distinct address gets one message with inline images. Actual Gmail IDs, timestamps, sender and per-recipient status are retained.
- **Connections:** separate Google sign-in buttons for Gmail and Sheets. End users do not enter Google API keys. States reflect stored OAuth connections; no simulated success.
- **Settings:** extraction toggle, provider, model dropdown, encrypted provider key, compatible-provider base URL, and a saved-configuration test. Gemini and Anthropic Claude model choices are visible immediately without an API key. These bundled catalogs are not a guarantee of account access. Enter a key and use Refresh list to fetch the account-specific list, including pagination; saved keys refresh automatically. Listing models does not save or change credentials, and a failed refresh keeps the visible choices. Gemini models without `generateContent` support remain visible in live results but cannot be selected for extraction; Anthropic models explicitly marked as not supporting image input are also disabled. Other models still need to support image input. The Base URL field is shown only for compatible providers.

## One-time Google application setup

Copy `.env.example` to `.env`, then fill in a Google **Web application** OAuth client ID and secret. Enable Gmail API and Google Sheets API in that Google Cloud project for the connectors. Register both exact redirect URIs on the same OAuth client:

```
http://localhost:3088/api/oauth/google/callback
http://localhost:3088/api/auth/google/callback
```

The first URI serves Gmail/Sheets connections; the second serves Gather login (`GOOGLE_LOGIN_REDIRECT_URI`). Restart the server to enable **Continue with Google**. Without the client ID and secret, the button explains that application setup is needed, and email/password login remains available. End users never enter Google API keys.

After signing in, open Connections and connect both services. They may use different Google accounts. Gmail asks for sending access; Sheets asks for spreadsheet read/write access. The API client uses OAuth access and refresh tokens. Google verification/testing restrictions depend on the OAuth app's publishing status.

API credentials for Gemini, Anthropic Claude, or a compatible vision provider are entered in Settings. Choose a model from the provider's live list rather than typing its ID. Compatible base URLs must end at the API root (for example `/v1`); the app adds `/models` for discovery and `/chat/completions` for extraction. Changing providers/endpoints clears the previous key so it is not sent to a different service by accident.

## Anthropic Claude setup

In **Settings**, choose **Anthropic Claude**, enter your Anthropic API key, and choose the Claude model you want from the **Model** dropdown. Turn on **Enable card extraction** and click **Save configuration**. **Test saved configuration** checks that exact saved model and key. Claude does not require a Base URL.

The initial dropdown includes documented Claude models. **Refresh list** loads all models available to your key from Anthropic, including subsequent pages and newer models, without saving the key or changing your selection. A saved Anthropic key refreshes this list automatically when Settings opens. Account access is checked by the live API; the initial catalog does not guarantee access. Keys are encrypted on the server, and changing the provider clears a typed key so it cannot be carried over to another service. Changing only the Claude model keeps your saved Anthropic key.

Card reading uses Anthropic's native Messages API with the selected model and the uploaded image. Failed, refused, empty, or truncated responses leave the card available for attention. API integration follows Anthropic's [Models API](https://platform.claude.com/docs/en/api/models/list), [Messages API](https://platform.claude.com/docs/en/api/http/messages/create), and [vision documentation](https://platform.claude.com/docs/en/build-with-claude/vision).

## Data and sync

Workspace data and retained image files are persisted in the ignored `data/` directory. Successfully extracted card photos are removed after the approved contact is durably saved; contact details and upload history remain. The hosted app deletes the corresponding encrypted image record from PostgreSQL too. Failed/unapproved cards and images referenced by templates, campaigns, or other uploads are retained. If deletion fails, cleanup retries on refresh or restart without making another model call. OAuth refresh tokens and LLM keys are encrypted with an installation key stored in `data/.secret-key`, with file permissions restricted to the local user. Back up the entire directory together. Secrets are omitted from the browser state API and never written to browser storage.

New and edited contacts, including approved card scans and duplicate merges, sync immediately to their workspace’s linked spreadsheet after the contact is durably saved. Linking a spreadsheet also syncs existing workspace contacts. Unapproved cards stay in review. If Sheets fails or the account is disconnected, the saved contact remains pending with a visible error and Retry sync action. The next contact save also retries pending changes in that workspace. Refresh from sheet imports edits made directly in Google Sheets; there is no background polling.

Sync uses a stable Gather ID in column A. Locally edited contacts take precedence; otherwise spreadsheet edits are imported. New rows are appended using RAW values (not formulas). Sync is additive: it does not delete local contacts when a spreadsheet row disappears. The connected spreadsheet is synced before a campaign draft freezes its recipient list. Template changes after that point do not alter the draft.

This build is bound to localhost and intended for one authenticated owner. It is not a public multi-user deployment. A hosted release needs HTTPS with Secure cookies, account-scoped data and connection ownership, verified account recovery, shared transactional storage, and a durable background queue. The reference CRM's Firebase identity model can be used for that phase.

## Bulk email

Click **Send bulk email** on Overview or Communication to refresh the workspace’s Gather Contacts sheet and load every eligible address. Choose a saved template, save the draft, then confirm the sender, message, and final recipient count with **Confirm & send**. The complete list is automatically divided into batches of up to 100; one confirmation starts every batch. For example, 537 addresses become five batches of 100 and one of 37. Progress shows the total sent and batch completion. **Pause sending** stops after the active request finishes, and **Resume campaign** continues the remaining recipients. Bulk mode includes fresh sheet rows even when an older contact selection exists; duplicate and excluded addresses are skipped. The sender is the connected Gmail account. Keep the app tab open during sending and quota waits. If the tab closes or the browser stops, reopen the campaign and resume; this build does not have an independent background email worker.

## Delivery behavior and limits

- There is no 100-recipient campaign limit. Recipients are frozen into batches of up to 100 and sent sequentially with a short interval. Gmail account quotas and hosting/storage capacity still apply; batching does not make delivery unlimited.
- Gmail must return a message ID before a recipient is marked sent. This confirms submission, not inbox placement or reading.
- Explicit Gmail quota/rate-limit rejections pause the campaign and keep the rejected recipient pending. The app honors Gmail’s retry time, or uses an increasing wait when none is supplied, then continues automatically while the tab remains open. Daily API quota errors without a retry time wait 24 hours. Permission failures and ambiguous/transport/5xx outcomes stop for attention and are never retried automatically. The cooldown and every recipient’s status survive restarts.
- A server interruption during submission marks that recipient unknown on restart. Check Gmail Sent before creating a replacement campaign. Completed campaigns cannot be submitted again; paused campaigns resume only pending recipients.
- Sender names on a visiting card are not assumed to own every email address. Personalization defaults to the business team or a generic greeting.
- This build supports one connected Gmail account and one Sheets account at a time. Workspace sheets retain their owning Google account identity.

## Verification

```sh
npm run check
npm test
```

Tests use isolated temporary installations and mocked Google/LLM responses. They cover account setup, separate-account registration, login, session rotation/expiry, sign-out, password changes, authentication enforcement, rate limiting, extraction, persistence, workspace isolation, multi-address contacts, merge review, credential redaction, OAuth browser/session binding, Sheets synchronization, image MIME messages, send confirmation, deduplication, and uncertain-delivery handling. They do not send real emails or create real spreadsheets.

The original browser-only script is retained as `app.v1.backup.js`. Old localStorage data is not overwritten; Settings offers an explicit migration when the new installation is empty. Mock connection claims and historical sending counts are not imported.

Automatic extraction groups up to 40 selected images into batches of 10, using one request per card within each group. Failed cards receive one automatic retry at the end of their group; successful cards are never re-read. Retry counts survive refreshes and restarts, with a maximum of two automatic model attempts per card. An interrupted first attempt has one retry left; an interrupted second attempt requires manual attention. AI-completed cards left in review by an older release are approved once on the next refresh without another model request. Successful existing card images are also cleaned up when their approved contacts are present. Approval never sends email; campaigns still require an explicit final confirmation.
