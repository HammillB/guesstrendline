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

## Usage counts

The page posts `{"e": "<event>"}` to `/api/event` and the Worker adds one to that day's total in the D1 database `fittheline-stats` (binding `STATS`, table `counts(day, event, n)`). Only the count is stored. Visits are counted separately by Cloudflare Web Analytics, which Cloudflare injects into the pages automatically.

| Event | Sent when |
| --- | --- |
| `solo_round` | a solo player presses Check |
| `solo_game` | a solo player finishes all 10 rounds |
| `class_created` | a teacher launches a class |
| `class_join` | a student takes a new seat in a class (not a rejoin) |
| `class_line` | a student locks in a line |
| `class_round` | a teacher reveals a round |

To read them: Cloudflare dashboard > Storage & Databases > D1 > `fittheline-stats` > Console, or from this folder:

```
npx wrangler d1 execute fittheline-stats --remote --command "SELECT event, SUM(n) AS total FROM counts WHERE day >= date('now', '-30 days') GROUP BY event"
```

The table was created with:

```
CREATE TABLE counts (day TEXT NOT NULL, event TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, event))
```

## Tests

`node tests/worker.test.mjs` runs the Worker against fake Turnstile, Google and Firestore servers.
