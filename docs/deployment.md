# Deployment

The [live public demo](https://eeevp.synteq.app) runs read-only on one Synteq App backed by one private Cloudflare R2 bucket. It uses synthetic samples and an intentionally public prefilled key. Synteq supplies the runtime and HTTPS. R2 holds the library descriptor, encrypted catalog, chunks, drafts, and deletion markers. The bucket is deployment configuration, with no selector in the UI.

The app was deployed on October 21, 2026. Its current Synteq plan is `free`, with 250m CPU and 512 MiB RAM. The plan's base price does not establish unlimited usage or a hard spending cap; inspect current metering and billing before changing resources or traffic expectations.

Synteq Apps uses temporary local disk, so hosting requires the S3 driver. Local development uses the filesystem driver and a persistent Compose volume. The [hackathon rules](https://hack.synteq.app/rules) require a live `<name>.synteq.app` URL.

## Runtime configuration

All mandatory values are explicit. Build without deployment secrets and supply them at runtime.

| Variable | Value |
| --- | --- |
| `APP_ORIGIN` | Exact HTTP(S) browser origin with no trailing slash, path, query, fragment, or credentials |
| `SESSION_SECRET` | Independent random cookie-signing secret, 32–4096 characters |
| `DEMO_MODE` | Mandatory `true` for the public read-only demo; `false` for writable local/private use |
| `DEMO_PUBLIC_KEY` | Required only when `DEMO_MODE=true`: intentionally public canonical 32-byte base64url key, 43 characters |
| `STORAGE_DRIVER` | `s3` for hosting; `filesystem` for local development |
| `STORAGE_PATH` | Required for `filesystem`: absolute writable path, `/app/data` in local Compose |
| `S3_ENDPOINT` | Required for `s3`: the account's R2 S3 API endpoint |
| `S3_REGION` | Required for `s3`: `auto` for R2 |
| `S3_BUCKET` | Required for `s3`: exactly one private bucket |
| `S3_ACCESS_KEY_ID` | Required for `s3`: bucket-scoped access key ID |
| `S3_SECRET_ACCESS_KEY` | Required for `s3`: matching secret access key |
| `S3_FORCE_PATH_STYLE` | Required for `s3`: explicit `true` or `false` |
| `S3_PREFIX` | Required for `s3`: restricted nonempty relative object prefix, without a trailing slash |

Private encryption keys remain browser-only and are not server configuration. `DEMO_PUBLIC_KEY` is the explicit public exception: it is delivered to the editable prefilled field for synthetic samples. Never use an existing private recovery key for that setting. A random session secret can be generated with `openssl rand -hex 32`; it signs convenience-session cookies and cannot decrypt videos.

## Prepare the public dataset

Choose a dedicated public demo key and isolated R2 prefix. Keep the HTTP application in `DEMO_MODE=true`; it cannot initialize or upload its own dataset. Populate or replace synthetic samples through a separate privileged operator workflow using that intentionally public key and the same encrypted packet format.

The repository's opt-in operator harness requires an explicit publication or retirement action, validates the prepared media and its receipts, and keeps the prior record until replacement playback is verified. It is deployment-specific administration, not part of ordinary browser acceptance or the public API. Keep its prepared files and operator paths out of user-facing setup.

Public mode uses the published descriptor and samples. Private use stays `DEMO_MODE=false` with a different private key and prefix or filesystem volume; never point the public demo at a private dataset. Its import and generation controls remain under the initially collapsed **Advanced key tools**.

## Configure R2 and deploy

Create one private bucket and an [R2 S3 API credential](https://developers.cloudflare.com/r2/api/tokens/) restricted to that bucket with the read, list, write, and delete permissions the application needs. Keep these credentials server-side. Browser video requests go through EEEVP APIs.

Prepare `.env.production` from `.env.example`. Set `STORAGE_DRIVER=s3`, all seven `S3_*` settings, the exact Synteq origin, a real session secret, `DEMO_MODE=true`, and its dedicated `DEMO_PUBLIC_KEY`. Protect the file with `chmod 600 .env.production`. Private encryption keys and private recovery files must never be included.

With the Synteq CLI authenticated and the intended project selected, inspect plan availability and deploy. Replace the example slug with an available name and ensure `APP_ORIGIN` matches its HTTPS origin:

```sh
synteq api GET /apps-plans
synteq deploy --create sample-video-library --plan free --location dfw --env-file .env.production
```

The CLI builds the Dockerfile and imports the environment file as runtime settings, excluding that file from the source bundle. The image packages Next.js standalone output and the generated playback service worker. Confirm resource and spending limits before creating an app.

For an existing app, use its actual slug:

```sh
synteq deploy --app sample-video-library --env-file .env.production
```

The bucket and prefix are fixed server configuration. Use separate prefixes for isolated tests. Storage failures must not switch backends or construct replacement empty state.

## HTTPS and request handling

The platform ingress terminates HTTPS. Preserve the original Origin header and session cookie. If request bodies are limited, allow at least 1,048,604 bytes per encrypted chunk. Keep no-store API responses and worker cache headers. The service worker must remain available at `/eeevp-sw.js` on the same origin with scope `/`.

The session is not proof of key possession. Public demo mode enforces read-only library routes on the server; writable private-use mode retains the [integrity and availability limits](security.md#session-and-mutation-limits) of accepting mutations from any opened session.

## Verify the app

Check `/api/health` at the app's actual HTTPS origin. A successful response is `{"ready":true}` after configuration validation and exercising the selected storage backend.

Check that `/robots.txt` disallows all paths and page metadata requests `noindex, nofollow`. These are crawler directives, not access controls.

Confirm that the editable field contains the intentionally public demo key, then select Decrypt & Login. Browse and search the seeded samples, play them, and seek across chunk boundaries. A different nonempty key must still enter the catalog while leaving encrypted names unreadable and videos unplayable; it must not be rejected by a server key check.

Test the mutation APIs directly with an active session: initialization, draft creation, chunk writes, completion, and deletion must all return `403` without changing the dataset. Upload and delete controls alone are not the enforcement boundary.

Lock library must stop playback and clear active key state and the cookie; the public prefill remains available on the gate. Restart or redeploy the app and verify that descriptor, catalog, chunks, and deletion markers remain available through R2. Writable upload/delete tests run separately with `DEMO_MODE=false` and isolated data.

In Firefox, leave the player idle for at least 35 seconds before playing and seeking. The still-open page can restore a browser-terminated worker on demand; after locking, that playback URL must remain inaccessible.

Playback preserves the original MP4 or WebM file. Its codecs must be supported by the browser; storage health cannot make an unsupported codec playable.

## Backups and changes

Back up the entire configured object prefix, including the immutable descriptor, wrapped keys, drafts, committed records, chunks, and deletion markers. Keep private recovery keys separately; the demo key is deliberately public configuration. Retained backups can contain deleted encrypted files, so define their retention accordingly. Replacing the descriptor is not a private-key recovery procedure.

Rotating `SESSION_SECRET` invalidates existing cookies without changing encrypted video data. Update `APP_ORIGIN` when changing the hosted origin. There is no built-in encryption-key rotation workflow.

## Local filesystem maintenance

The maintenance script operates only on local filesystem storage. It is not an R2 administration tool. Hosted object maintenance must preserve deletion markers and must not erase unrelated objects or prefixes.

`scripts/cleanup-drafts.mjs` defaults to a dry run. It considers unpublished drafts at least 24 hours old, skips committed videos and recent activity, rejects symlinks, and rechecks candidates. Output contains aggregate counts, mode, and minimum age.

Stop every writer and back up the complete local `video_data` volume before applying cleanup. Filesystem checks alone cannot prevent a concurrent upload from completing while its draft is removed:

```sh
docker compose stop web
docker compose run --rm --no-deps web node scripts/cleanup-drafts.mjs
docker compose run --rm --no-deps web node scripts/cleanup-drafts.mjs --apply
docker compose up -d web
```

Inspect dry-run counts first. A longer retention period can be supplied with the same `--older-than-hours` value on both runs; it must be a whole number at least 24. Preserve the volume and verify playback afterward. Interrupted filesystem deletion can leave encrypted files under `.trash`; inspect them with the app stopped and backed up before removal.
