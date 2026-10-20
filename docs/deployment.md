# Deployment

Deploy EEEVP as one application service on a small Synteq VPS with durable filesystem storage. Use the production Compose file to preserve encrypted videos across container replacement. Choose a server and disk within the available credit budget before provisioning, and monitor usage during the deployment.

An ephemeral application filesystem cannot hold uploaded videos. Every server process must access the same durable files; separate instances with independent disks are unsupported.

## Runtime configuration

All four values are mandatory and validated at request time. The production image is built without deployment secrets.

| Variable | Required value |
| --- | --- |
| `APP_ORIGIN` | Exact public origin, such as `https://example.com`, with no trailing slash, path, query, or fragment |
| `LIBRARY_PASSWORD` | Independent random library sign-in password, 16–1024 characters |
| `SESSION_SECRET` | Independent random cookie-signing secret, 32–4096 characters |
| `STORAGE_PATH` | Absolute writable path on persistent storage; production Compose sets `/app/data` |

Generate separate random values for the library password and session secret. For example, run `openssl rand -hex 32` independently for each value. Store them in a protected `.env.production` file on the server. These runtime secrets are separate from the library encryption key created in the browser.

## Start the service

Install Docker with Docker Compose on the VPS, then place the source checkout on that server. From the checkout:

```sh
cp .env.example .env.production
${EDITOR:-vi} .env.production
chmod 600 .env.production
docker compose -f compose.production.yml up --build -d
```

Set `APP_ORIGIN` to the real HTTPS origin and replace both example secret values before starting. The Compose file binds the application to `127.0.0.1:3000` and mounts the persistent `video_data` volume at `/app/data`. The runtime runs as the image's unprivileged Node user.

The Dockerfile runs `NODE_ENV=production yarn build` and packages Next.js standalone output, static files, and the playback service worker. Builds need more memory than the idle runtime; if the VPS is too small to build, build the same image on a compatible machine and transfer it rather than enlarging the running service without checking the budget.

## HTTPS

Point the chosen hostname at the VPS. Put an HTTPS reverse proxy in front of the loopback application port. A Caddy configuration can be as small as:

```caddyfile
example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Replace `example.com` with the configured hostname. Permit public HTTP/HTTPS traffic for certificate issuance and access; keep port 3000 bound to loopback. Forward the original `Origin` header and session cookie. If the proxy limits request bodies, allow at least 1,048,604 bytes for each encrypted chunk.

Do not cache video API responses or alter the service-worker cache headers. The worker must remain available at `/eeevp-sw.js` on the same origin with scope `/`.

## Verify a deployment

```sh
docker compose -f compose.production.yml ps
curl --fail https://example.com/api/health
docker compose -f compose.production.yml logs --tail 100 web
```

The health response is `{"ready":true}` when configuration is valid and the storage directory can write and sync a real file. Test the complete browser flow over HTTPS: sign in, explicitly initialize the library, save the recovery key, and upload a short supported video. On another device, sign in and enter the same library key; the uploaded video must appear and support playback and seeking. Check that reloading requires the key again and that locking ends authenticated access.

Restart the container and verify that the descriptor and full catalog remain available after signing in and entering the key. Test deletion with a disposable video and confirm that it disappears from a refreshed catalog on both devices.

Use a video whose original codecs the target browser supports. A healthy server cannot make an unsupported codec playable. A playback worker update can require reopening the video; reloading the page requires entering the library key again.

## Preserve and back up videos

Keep the production Compose project name and `video_data` volume stable across releases. `docker compose -f compose.production.yml down` preserves the volume; adding `--volumes` deletes it. Recreating the VPS can also destroy files unless its storage lifecycle explicitly preserves them.

Back up the full mounted storage directory, including `library.json`, encrypted video-key records, drafts, committed manifests, and chunks. Stop the application while taking a filesystem-consistent backup, then restart the service. Restore the complete directory with ownership writable by the runtime user and verify readiness, library unlock, catalog listing, and playback with the retained library key.

Store the master-key recovery copy separately from filesystem backups. The server never holds that key, and replacing or deleting the library descriptor is not a recovery procedure. Define backup retention with permanent video deletion in mind: retained backups can still contain deleted encrypted files.

Monitor free disk space and bandwidth. Each encrypted chunk adds 28 bytes to its plaintext size, with additional manifest and filesystem overhead. Canceled uploads can leave unpublished files. There is no automatic retention job; use the maintenance procedure below for expired drafts. Users can delete committed videos through the library's confirmation dialog.

Deletion first moves a video outside the catalog into a private `.trash` directory, then removes its files. A server failure between those steps can leave ciphertext there. With the application stopped and the full volume backed up, an operator can inspect and remove abandoned trash entries. The draft-cleanup script does not process that directory.

## Clean up interrupted uploads

The maintenance script defaults to a dry run. It considers unpublished drafts at least 24 hours old, skips committed videos and recent activity, rejects symlinks, and rechecks candidates before removal. Its output reports aggregate counts, mode, and minimum age without filenames or video contents. It does not delete committed videos or the `video_data` volume.

Stop every application process that can write to this filesystem before using `--apply`. Filesystem rechecks alone cannot prevent a concurrent upload from completing while its draft is being removed. For the single-service production deployment:

```sh
docker compose -f compose.production.yml stop web
```

With the application stopped, back up the complete `video_data` volume as described above. Then inspect the dry-run counts before applying cleanup:

```sh
docker compose -f compose.production.yml run --rm --no-deps web node scripts/cleanup-drafts.mjs
docker compose -f compose.production.yml run --rm --no-deps web node scripts/cleanup-drafts.mjs --apply
docker compose -f compose.production.yml up -d web
```

Keep other writers stopped until cleanup finishes. The temporary maintenance container uses the same production image, configuration, and persistent volume. To use a longer retention period, pass the same `--older-than-hours` value to both runs; it must be a whole number of hours at least 24. Verify readiness and a retained video's playback after restarting.

## Update or rotate access

Rebuild and recreate the service with the production Compose command after source changes. Preserve the persistent volume. When rotating configuration, update the real `.env.production` values and recreate the container so it receives them.

Rotate `SESSION_SECRET` to invalidate existing session cookies. Changing the library password alone affects new sign-in attempts; signed cookies remain valid until expiry. Neither rotation changes the browser library key or encrypted video keys. There is no built-in library encryption-key rotation workflow.
