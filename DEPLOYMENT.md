# Firebase deployment status

Checked on 2026-09-08. **The application has not been deployed.**

## Verified target

- Project ID: `automation-1b52f`
- Project name: Gmail automation
- Project number: `927561890485`
- Existing default Hosting site: `automation-1b52f`
- Hosting URL reserved by Firebase: `https://automation-1b52f.web.app`
- Google Cloud CLI can access the project.
- Firebase CLI credentials are expired. Firebase management REST requests succeed with a Google Cloud access token and `x-goog-user-project: automation-1b52f`; do not print or persist access tokens.
- No Firebase web app is registered. Firebase Authentication configuration is not initialized.
- Cloud Run and Firestore APIs are not enabled.
- Project billing is disabled and no billing account is attached. The only visible billing account, “My Billing Account,” is closed.

## Required project action

Attach an active Cloud Billing account to this project. This enables the Blaze plan needed for the proposed Firebase Hosting + Cloud Run backend. A billing account must be active even when backend use fits within Cloud Run's free usage quota. See [Firebase's Cloud Run prerequisites](https://firebase.google.com/docs/hosting/cloud-run#before-you-begin).

Use [project billing](https://console.cloud.google.com/billing/linkedaccount?project=automation-1b52f). Reopening the closed account or adding payment details requires the account holder. No billing account was linked, reopened, or created during this attempt.

## Implementation required before release

This is a local Node application, so publishing the current files as a static site does not deploy the functioning CRM. Its API handles authentication, protected images, encryption, OAuth connections, extraction, and Gmail sends.

1. Provision the backend and durable storage in the selected project. Move CRM records, account/session state, pending OAuth state, and images out of instance-local files; preserve the existing superadmin account using its password hash. Store encryption keys and OAuth secrets in Secret Manager. Never include `data/`, `.env`, passwords, or secrets in a Hosting upload or container image.
2. Adapt the server to Cloud Run's `PORT`, listen on `0.0.0.0`, and validate configured public HTTPS origins. The current local-only Host check rejects public hosts.
3. Adapt sessions and OAuth browser binding to the `__session` cookie, with Secure/HttpOnly attributes. Firebase Hosting strips other cookies before proxying to Cloud Run; simply setting Secure on the existing cookie names is insufficient. See [Firebase Hosting cookie behavior](https://firebase.google.com/docs/hosting/manage-cache#using_cookies).
4. Make persistence and concurrency safe across restarts and overlapping instances/revisions. A process-local queue and synchronous JSON files are insufficient for cloud data or delivery deduplication.
5. Run long campaigns in a durable job queue with recipient-level send state; keep API responses within Hosting's timeout. Preserve ambiguous-delivery protection and explicit send confirmation.
6. Configure Google login plus Gmail/Sheets OAuth redirect URLs for the public site. Google OAuth application credentials are still absent locally; Firebase project access does not supply them automatically.
7. Stage an explicit allowlist of browser assets for Hosting and route API/protected assets to the backend. Keep account creation closed once the migrated superadmin is present.
8. Verify hosted login/logout, Google callbacks, persistence across restarts, protected assets, upload limits, workspace data, and campaign behavior using test data. Release Hosting only when its backend is healthy. Do not send real customer emails as part of deployment verification.

The local installation and its existing superadmin account were not changed by these deployment checks.
