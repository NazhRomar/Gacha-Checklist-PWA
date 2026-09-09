# Sync + push backend

A tiny Cloudflare Worker that stores one JSON blob per PIN, so the app can push
your progress up from one device and pull it down on another. Also sends Web
Push notifications (reset reminders, low-progress nudges) on a cron schedule.
Free tier is plenty for personal use (100k reads/day, 1k writes/day).

## Deploy (one-time)

1. Sign up at https://dash.cloudflare.com (free) if you don't have an account.
2. Install Wrangler and log in:
   ```
   npm install -g wrangler
   wrangler login
   ```
3. From this folder, create the KV namespace:
   ```
   wrangler kv namespace create SYNC_KV
   ```
   This prints an `id`. Paste it into `wrangler.toml` in place of
   `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.
4. Deploy:
   ```
   wrangler deploy
   ```
   Wrangler prints your Worker's URL, e.g. `https://gacha-checklist-sync.<you>.workers.dev`.
5. In the app's hamburger menu, choose **Set Up Sync** and enter that URL plus
   a PIN (6+ characters - treat it like a password, since anyone with the PIN
   can read/write that slot). Enter the same URL and PIN on your other device.

That's it - the app pushes changes automatically after you edit something, and
pulls periodically and whenever you reopen/switch back to it.

## Push notifications (one-time, additional)

Notifications need a VAPID key pair - the *public* half ships in the app's
own `script.js` (it's meant to be public), the *private* half is a Worker
secret and must never be committed.

1. Generate a P-256 key pair and export it as a JWK, e.g. with Node:
   ```js
   const { publicKey, privateKey } = require("crypto").generateKeyPairSync("ec", { namedCurve: "prime256v1" });
   const pub = publicKey.export({ format: "jwk" });
   const priv = privateKey.export({ format: "jwk" });
   console.log(JSON.stringify({ crv: "P-256", kty: "EC", d: priv.d, x: pub.x, y: pub.y })); // -> VAPID_PRIVATE_KEY
   ```
2. Set it as a secret (paste the full JSON string from above when prompted):
   ```
   wrangler secret put VAPID_PRIVATE_KEY
   ```
3. Update `VAPID_PUBLIC_KEY` in the app's `script.js` to match (base64url of
   the uncompressed point `0x04 || x || y` from the same key pair).
4. Redeploy: `wrangler deploy` (this also registers the cron trigger in
   `wrangler.toml` that checks for due notifications every 5 minutes).

## Updating later

If you ever change `worker.js`, redeploy with `wrangler deploy` from this folder.
