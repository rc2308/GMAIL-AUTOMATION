# Gather on Vercel

Target team: `rounakchhatait-5235s-projects`.
Project: `gather-crm` (`prj_NzkpJq0CKXpyObPJJh1wxDfClREj`).

## Live deployment — 9 September 2026

Production: https://gather-crm.vercel.app

Deployment: `dpl_8T2YKCNqhn62Vw2W151zTkYJuv4E`. Neon database `gather-crm-db` is provisioned on the free plan in Singapore and connected to production. The existing superadmin account, two workspaces, and one image were migrated; there were no contacts. Continue using the existing superadmin password.

Verified on the live deployment: superadmin sign-in, workspace and settings screens, persistence across reloads and separate requests, authenticated image access, unauthorized API/image rejection, private source/data paths returning 404, and session revocation on logout. Browser checks reported no JavaScript errors or desktop horizontal overflow. Database checks verified encrypted records, persistence, and concurrent-write exclusion. The automated suite now passes all 55 tests, including automatic extraction approval, unique email/phone duplicate merging, one-time pickup of cards from the earlier review flow, registration after initial setup, cross-account object/image denial, separate Google accounts, per-account password/session changes, legacy owner migration, and account persistence across fresh serverless directories. No real emails were sent; real extraction has not been verified in production.

Google OAuth credentials from the user's downloaded web-client JSON are installed as sensitive production environment variables. The authorized origin and both registered callbacks match this deployment. Gmail and Sheets APIs are enabled in project `automation-1b52f`. The live Google button reaches Google's sign-in page successfully; PKCE, Secure/HttpOnly OAuth cookies, and cancellation handling were verified. Completing Google consent, account linking, and real Gmail/Sheets operations still requires the user. No Google account was linked by the verification run.

To finish account linking, sign in with the existing superadmin password, click **Super Admin** in the top bar, then **Link Google account**. Subsequent visits can use **Continue with Google**. Gmail and Sheets are connected separately under **Connections**. New users can register directly using email/password or Google and receive their own empty CRM; they do not need the superadmin password. Keep the downloaded credential JSON private and outside the project; it was not copied into the source or deployment bundle.

The Node backend runs as a Vercel Function using the Build Output API. A PostgreSQL database stores encrypted CRM records, account/session state, pending OAuth state, and protected images. Temporary files are per-request working copies; they are not the source of truth. A direct PostgreSQL connection holds a session-level advisory lock across each request, and every write is committed before success or the next external action. Do not substitute a pooled/PgBouncer connection.

The automatic Sheets sync update saves contacts durably before immediately syncing their workspace. It covers manual saves/edits, card approvals, duplicate merges, and linking spreadsheets with existing contacts. Provider failures retain pending contacts and expose Retry sync; subsequent contact saves also reconcile pending changes. Mocked tests and a browser run verified workspace routing, multiple addresses, failure recovery, and lost-append-response deduplication. This release was not verified by writing to a real Google spreadsheet.

Bulk email is available from Overview and Communication. It refreshes the sheet before showing recipients and includes fresh sheet rows again when creating the final draft, regardless of stale contact selections. The saved template and connected Gmail sender are shown before explicit confirmation. A mocked browser run verified three recipients, the message preview, and no send before confirmation.

## Provisioning

Create a Neon database through the Vercel Marketplace with plan `free_v3`, region `sin1`, and Neon Auth disabled. Connect it to this project's production environment. The account holder must accept the integration's terms at the [Vercel consent page](https://vercel.com/rounakchhatait-5235s-projects/~/integrations/accept-terms/neon?source=cli).

Required production environment variables:

- `DATABASE_URL_UNPOOLED` (or `POSTGRES_URL_NON_POOLING`): direct PostgreSQL URL.
- `GATHER_STORAGE_KEY`: base64-encoded 32-byte installation encryption key. To migrate this local CRM, use the existing bytes in `data/.secret-key`. Supply the value privately as a sensitive Vercel environment variable; never print it or commit it.
- `GATHER_PUBLIC_ORIGIN`: the exact production HTTPS origin.

Google login and Google connectors additionally need the application's OAuth client ID and secret, with these callbacks registered for the chosen production domain:

- `/api/auth/google/callback`
- `/api/oauth/google/callback`

Set `GOOGLE_LOGIN_REDIRECT_URI` and `GOOGLE_OAUTH_REDIRECT_URI` to the corresponding full HTTPS URLs. These credentials were not present in the local installation; publishing the app does not configure Google's OAuth client automatically.

## Initial migration

Pull production environment variables into the ignored `.env.production.local`. Then run:

```sh
node --env-file=.env.production.local scripts/migrate-cloud.mjs
```

Migration creates the `gather_files` table and copies the existing account hash, CRM records, and images in one transaction. It drops local sessions and pending OAuth requests from the cloud copy and refuses to replace an existing cloud account. The local data is not modified. The hosted app refuses to initialize a public owner account from an empty database.

## Build and publish

```sh
npm ci
npm run check
npm test
npm run build
vercel deploy --prebuilt --prod --scope rounakchhatait-5235s-projects
```

The build copies an explicit code/dependency allowlist into `.vercel/output`. It excludes `.env*`, `data/`, local passwords, and the prototype backup. Configuration uses Node.js 22, the Singapore region, and a 300-second maximum function duration. The backend validates exact application hosts/origins and issues Secure/HttpOnly cookies.

## Hosted behavior

- Images are limited to 3 MB and uploaded one at a time, within Vercel's function payload limit. Bulk selection remains available.
- Each send request handles one pending recipient and durably records the sending state before calling Gmail. The frontend continues through the campaign while open. If it stops between requests, **Resume remaining** handles untouched recipients. Failed or uncertain deliveries stop the campaign and are never retried automatically.
- The request-level database lock serializes operations across accounts in this small CRM deployment. A busy database returns a retryable service-unavailable response instead of allowing concurrent sends or inconsistent JSON snapshots. Accounts have isolated records, but storage still uses encrypted JSON documents and a global lock; this is not a high-throughput architecture.
- Data persistence, account creation, OAuth state, and send checkpoints use awaited writes. Database records and images are encrypted using authenticated AES-256-GCM; the encryption key lives in Vercel's environment, not in the database.
- The local and hosted databases are independent after migration. Local edits are not automatically replicated to the hosted installation.

Before sharing a live URL, verify the migrated superadmin can sign in, unauthorized state/assets return 401, data survives separate function invocations, and a test image can be uploaded and read only while authenticated. Google and email tests must use mocks or explicitly authorized test recipients.

References: [Vercel Node functions](https://vercel.com/docs/functions/runtimes/node-js), [Build Output API](https://vercel.com/docs/build-output-api/primitives), [storage](https://vercel.com/docs/storage).

## Registration and account isolation

`auth.json` retains the original owner and adds member accounts. Sessions are tied to an account ID; legacy sessions without an account ID continue to belong to the original owner. The owner keeps the existing root `gather.json` and images. Additional accounts use `accounts/<server-generated-user-id>/gather.json` and similarly prefixed image keys. The server selects the prefix from the authenticated session, never from a submitted workspace, role, or account ID. A client account header prevents stale tabs from writing after another account signs in.

Before this release, all existing hosted records were backed up as ciphertext to the ignored, private `data/backups/` directory. No Google email was sent during verification.

Production verification passed after deployment: the browser created a temporary member account after the superadmin existed, saved a workspace and image across requests/reloads, and could not access the superadmin's images or workspace. The superadmin retained its two workspaces and one image and could not read the member's image. The temporary account and its prefixed records were removed afterward under the database lock. Local browser checks also passed at widths 1440, 768, 390, and 320 pixels.

## Google production branding pages

Public homepage: https://gather-crm.vercel.app/about
Privacy policy: https://gather-crm.vercel.app/privacy
Terms: https://gather-crm.vercel.app/terms
Authorized domain: `gather-crm.vercel.app`. Support/developer contact: `rounakchhatait@gmail.com`.

These static pages are available without login, are included in the explicit deployment allowlist, and are linked from the authentication UI. Browser checks covered links, anonymous access, private-route protection, and widths 1440/390/320. Google Console branding fields still need to be saved by the account holder. Publishing these pages does not change Google's Testing status or complete brand, domain, or sensitive-scope verification.

## Automatic card extraction

Uploads record a durable extraction state: queued, needs_setup, extracting, complete, or failed. The browser starts pending cards automatically after upload, settings setup, or a fresh page load, using one extraction request per card. It must remain open to progress through the queue. Queued cards and an unused automatic retry resume on return; exhausted retries require manual attention. Automatic requests for already-read or resolved cards do not call the AI again. Valid extracted cards are approved immediately and synced to the workspace spreadsheet. A unique email or phone duplicate merges automatically; a business-name-only match remains separate. Invalid or insufficient extracted data remains available for attention. A browser flow verified two same-phone Harbor cards merging both emails without a review click. The provider key/model is still configured separately for each account.

## Automatic email batches

Campaigns now accept the complete eligible spreadsheet audience and partition it into batches of up to 100. One final confirmation authorizes the frozen list and starts automatic sequential progression through every batch. Hosted requests still submit one recipient at a time; compact progress responses avoid returning the full audience after each message. Campaign views show sent totals and completed batches, and allow pausing/resuming.

Explicit Gmail 429 or recognized 403 quota rejections preserve the recipient as pending and persist a retry time. While the tab stays open, the runner waits and continues automatically after that time; closing it requires resuming the campaign on return. There is no independent background worker. Other failures and ambiguous outcomes stop for attention, and confirmed or uncertain sends are never automatically repeated. This handling follows [Google’s Gmail error guidance](https://developers.google.com/workspace/gmail/api/guides/handle-errors).

Verification uses mocked Gmail and Sheets: 537 addresses across six batches, hosted continuation across restart, duplicate/excluded-address handling, saved cooldowns for 429/403 responses, and stopping on unknown deliveries or permission failures. No real email is sent by these checks.

## Card batches and image cleanup

The browser accepts up to 40 card photos per selection and processes them in logical groups of 10. Hosted uploads still transfer one image per request, and extraction uses one image per model request to fit payload and execution limits. Within each group, only failed cards get one automatic retry. The persisted retry count caps automatic extraction at two model attempts per card, including across restarts. Exhausted cards keep their images for review.

After contact approval is durably saved, the backend checkpoints cleanup intent, deletes the account-scoped PostgreSQL image record and local file, then removes its asset reference. Contact details and upload history remain with an image-removed status. Cleanup failures remain pending and are retried on refresh or restart without re-extracting. Existing successfully extracted and approved cards are included in cleanup. Photos referenced by other uploads, templates, or frozen campaigns are preserved.

Tests cover 40 cards in four groups, isolated retries, successful-file removal, retained failed images, interrupted cleanup, failed contact checkpoints, and deletion under the correct member account prefix. Verification uses temporary images and mocked providers/storage. All 88 tests pass. A browser upload of 40 images saved 40 contacts with 41 model attempts (one intentional transient failure), removed all 40 image assets and local files, and displayed the removal status for every card.

## Anthropic Claude support

Settings includes Anthropic Claude with an encrypted API key and a selectable model. The native Models API loads the account-specific list with pagination; card extraction uses the native Messages API and the selected model. Mocked tests cover key isolation, model selection, image messages, failures, and incomplete responses. No real provider requests were needed for release verification.
