# Create-class Worker

Lets only real browsers create classes. Students never use it.

A teacher's browser sends the Worker its Firebase sign-in token and a Cloudflare Turnstile token. The Worker checks both, then creates the class and its head-count document in Firestore with a service account.

## One-time setup

1. **Turnstile widget.** Cloudflare dashboard > Turnstile > Add widget. Hostnames: `fittheline.com`. Widget mode: Managed (or Invisible). Copy the **site key** (public) and the **secret key** (private).
2. **Service account.** Firebase console > Project settings > Service accounts > Generate new private key. In Google Cloud IAM, give that account only the role **Cloud Datastore User**. Keep the downloaded JSON private and out of the repo.
3. **Deploy.** From this folder:
   ```
   npx wrangler login
   npx wrangler secret put TURNSTILE_SECRET           # paste the secret key
   npx wrangler secret put FIREBASE_SERVICE_ACCOUNT   # paste the whole JSON file contents
   npx wrangler deploy
   ```
4. **Turn it on in the page.** In `firebase-backend.js` set `CREATE_CLASS_URL = '/api/create-class'` and `TURNSTILE_SITE_KEY` to the site key, then deploy the site. With both blank, the page creates classes directly as before.
5. **Rate limit (recommended).** Cloudflare dashboard > Security > WAF > Rate limiting rules: match URI path `/api/create-class`, limit about 10 requests per minute per IP.
6. **Privacy page.** Teachers who launch a class load Cloudflare Turnstile; say so in the privacy page.

## Locking it down (only after it has worked for a while)

Once teachers are creating classes through the Worker, change `allow create` on `/classes/{code}` in `firestore.rules` to `if false`, publish the rules, and the page can no longer create classes any other way. Undo by republishing the old rules.

## Tests

`node tests/worker.test.mjs` runs the Worker against fake Turnstile, Google and Firestore servers.
