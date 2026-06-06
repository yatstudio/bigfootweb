# Bigfoot Waitlist — Cloudflare Pages Setup

This project can collect B-Foot Trading Agent beta emails without a traditional database by using Cloudflare Pages Functions + Cloudflare KV.

## Files

- Public signup page: `/beta.html`
- Hidden admin viewer page: `/_bf8848.html`
- API function: `/functions/api/waitlist.js`

## Security notes

- Do not put the admin password in frontend HTML.
- Set the password as a Cloudflare Pages environment variable:
  - `WAITLIST_ADMIN_PASSWORD=88488848`
- Bind a Cloudflare KV namespace as:
  - `WAITLIST_KV`
- The admin page is only lightly hidden by path. Real protection comes from the server-side password check in the Pages Function.
- For stronger security later, replace the simple password with Cloudflare Access or GitHub/Google login.

## Cloudflare setup

1. In Cloudflare Dashboard, create a KV namespace, e.g. `BIGFOOT_WAITLIST`.
2. Open your Cloudflare Pages project.
3. Go to Settings → Functions → KV namespace bindings.
4. Add binding:
   - Variable name: `WAITLIST_KV`
   - KV namespace: `BIGFOOT_WAITLIST`
5. Go to Settings → Environment variables.
6. Add production variable:
   - `WAITLIST_ADMIN_PASSWORD`
   - value: `88488848`
7. Redeploy the Pages project.

## URLs after deployment

- Signup page: `https://bigfoot.capital/beta.html`
- Admin viewer: `https://bigfoot.capital/_bf8848.html`

## Local limitation

Opening these files directly from disk only verifies the UI. Actual email submission and admin listing require Cloudflare Pages Functions + KV after deployment.
