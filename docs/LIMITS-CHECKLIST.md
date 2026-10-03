# Hellfire Auctions: limits and costs to watch

The app emails you automatically (support@hellfireauctions.com) when it nears the email or database limits
below, and sends a monthly owner report on the 1st. This page is the full list.

| Service | What the free level allows (checked Oct 2026) | When it starts to hurt | What to do |
|---|---|---|---|
| Resend (email) | 3,000 emails/month and 100/day; 1 domain | A handful of busy stores (roughly 5-10) | Pro is about $20/month for 50,000 emails. Amazon SES is about $0.10 per 1,000 emails (cheapest). |
| Render (server) | Free server sleeps when nobody visits | Any time auctions must end exactly on time | Keep UptimeRobot pinging /healthz, or move to an always-on paid instance (about $7/month; confirm on Render's pricing page). |
| Neon (database) | 0.5 GB storage, 100 compute-hours/month | Hundreds of auctions and many thousands of bids | Launch plan is pay-as-you-go (about $0.106 per compute-hour, $0.35 per GB). |
| UptimeRobot | Free monitors, 5-minute checks | Not a limit we expect to hit | Free. |
| IONOS (domain) | Yearly renewal | The renewal date | Renew hellfireauctions.com; keep support@ forwarding working. |
| Shopify Partner | App review and protected-data approvals | Review emails need answers | Check the Partner dashboard and the email on the Partner account. |

## After you upgrade something
Set these in Render (Environment) so the warnings stay accurate:
- EMAIL_DAILY_LIMIT (default 100)
- EMAIL_MONTHLY_LIMIT (default 3000)
- DB_LIMIT_MB (default 500)
- OWNER_REMINDERS (optional): your own reminders, separated by semicolons, which are added to the monthly report.

## Why not run our own email server
Mail from a brand-new server is often blocked or sent to spam by Gmail and Yahoo, and the fix is ongoing work.
Amazon SES gives the same "send from your own domain" result for about $0.10 per 1,000 emails.

## Self-hosting the app and database
Possible on one small server (about $6-12/month), but then backups, security updates and uptime are our job.
Worth revisiting once there are paying stores.

## Backlog (not started on purpose)
- Amazon SES email switch: back-burnered by the owner. Do it closer to launch, or when email volume nears the Resend limit. Goal: moving to SES should be a settings change.
- Always-on Render server (about $7/month) before relying on real merchants; until then keep UptimeRobot pinging /healthz.
- After App Store approval: recurring auctions and templates, CSV import.
- Final end-to-end test of a full auction, and a last review of the listing text against what the app does.

## Weekly backup emails
The privacy policy says encrypted backups are kept for up to 30 days. Delete weekly backup emails older than about 4 weeks (keep the latest 4).
