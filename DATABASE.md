# Where the data lives

**Production database: Neon.** The server reads it from the secret setting `NEON_DATABASE_URL` (Render dashboard, the
hellfire-auctions service, Environment).

- **How to check which database the live app is using:** open the service's logs in Render and search for `[db]`. A healthy
  start says `[db] using Neon database`. If it ever says `WARNING: NEON_DATABASE_URL is not set`, the setting was lost: put it back.
- **Database updates (migrations)** run automatically at every start, against Neon (see `docker-start` in package.json).
- **The old Render database** (`hellfire-auctions-db`, created 30 September 2026, free plan) was retired in October 2026 and
  expires on 30 October 2026. Nothing reads or writes it. The `DATABASE_URL` setting on the server still points at it; that is
  harmless and can be deleted from Render's Environment page whenever you like (after 30 October it points at nothing).
- **Backups:** use Neon's own history/branches, and the Backup button in the app's Settings page for each store's auctions.
- **Local development:** set `DATABASE_URL` to a local or throwaway Postgres; leave `NEON_DATABASE_URL` unset.
