# Sync backend

A tiny Cloudflare Worker that stores one JSON blob per PIN, so the app can push
your progress up from one device and pull it down on another. Free tier is
plenty for personal use (100k reads/day, 1k writes/day).

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

## Updating later

If you ever change `worker.js`, redeploy with `wrangler deploy` from this folder.
