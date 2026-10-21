# Architecture

EEEVP is a video library with browser-held encryption keys. One Next.js application serves encrypted metadata and video chunks from durable storage. The [hosted demo](https://eeevp.synteq.app) runs on Synteq Apps with one fixed Cloudflare R2 bucket; local development uses a persistent filesystem volume.

## Browser workspace and session

Any nonempty key opens the browser workspace. The browser sends `POST /api/session` with an empty JSON object, and the server issues a signed HttpOnly convenience-session cookie. The raw key and imported recovery file never enter that request. The server does not determine whether the key can decrypt the library.

`DEMO_MODE=true` is the public read-only presentation. Its required `DEMO_PUBLIC_KEY` is deliberately known and supplied at runtime to an editable prefilled field. It uses public, non-sensitive samples in a separate storage namespace. `DEMO_MODE=false` is writable local/private use with a different key and namespace; private keys are not server configuration.

The public gate offers only the editable prefilled key and login. In private mode, recovery-file import and new-key generation are under **Advanced key tools**, collapsed on initial display. Files are read or generated locally.

The cookie supplies session presence and supports same-origin guards, without proving key possession. Public demo mode rejects library mutations with `403` before authentication, body parsing, or storage writes. Writable mode retains the [mutation authorization limits](security.md#session-and-mutation-limits).

The active key remains in browser memory across navigation. Reloading closes the workspace; private use requires supplying the key again, while public demo mode keeps its editable prefill. Locking clears active playback key state and the cookie. Private keys and decrypted catalog data are not persisted in localStorage or IndexedDB.

## Interface motion

The root layout keeps the library provider and page shell mounted across App Router navigation. Native React 19.3 `ViewTransition` and Next.js Link transition types animate route changes and deferred catalog filtering without reloading the browser key. Reduced-motion preferences remove movement and delays; ordinary navigation, search, and locking remain functional without the native browser API. Locking interrupts active motion and clears the workspace rather than waiting for an animation to finish. The integration uses no experimental configuration flags or additional motion library.

## Encrypted catalog

The server lists committed records from its durable backend. Each record contains an encrypted video manifest, wrapped video key, library identifier, and creation date. The server's records are the canonical catalog for every device.

The browser attempts to unwrap each video's key under the entered library key, then decrypts filename and media type. A matching key reveals those values and enables playback. A wrong key still opens the catalog, showing unreadable encrypted names without playable videos. Search operates on locally decrypted filenames.

Each video key is wrapped with AES-256-GCM using a fresh 12-byte IV and 16-byte authentication tag. Associated data binds the library identifier and complete validated manifest, preventing substitution into a different video record.

## Upload

A library has an immutable encrypted descriptor. Uploads operate only with `DEMO_MODE=false`. Before adding a video, the browser worker must be able to decrypt that descriptor with the entered key. This local upload guard prevents accidentally adding files under a wrong key; it is not server-side write authorization.

The dedicated upload worker generates an independent random 256-bit video key and identifier. It encrypts filename and media type, wraps the video key under the library key, and creates a server draft containing only encrypted metadata, the wrapped key, and the library identifier.

The worker reads, encrypts, and uploads one 1 MiB chunk at a time. Each AES-GCM packet contains a random 12-byte IV, ciphertext, and a 16-byte tag. Metadata authentication binds the format, video identifier, size, chunk size, and count. Chunk authentication additionally binds the index and encrypted metadata.

The server publishes a completed record only after all chunks have their expected lengths. The browser reads it back and refreshes the catalog. Completion, failure, cancellation, or locking terminates the upload worker. Unpublished drafts are excluded from normal catalog reads.

## Playback

The browser opens `/watch/:id`, fetches its encrypted record through the session, unwraps the video key, and decrypts metadata locally. A wrong key cannot complete this step.

A service worker creates an in-memory playback session bound to the initiating browser client. The native video element requests a virtual media URL using ordinary byte ranges. The worker fetches encrypted chunks, authenticates and decrypts them, then streams only the requested plaintext bytes to the media decoder.

Downloads use a sliding window of three packets within the requested byte range. Overlapping readers share in-flight downloads; canceling one reader releases its leases without interrupting another reader of the same packet. Running orphaned downloads receive at most 50 ms for an adjacent native range to reattach; new demand preempts unrelated orphans when download slots are occupied, while Lock and HTTP 401 cancel immediately. Ciphertext is reused in an in-memory LRU with an 8 MiB limit per playback session, 32 MiB across the worker, and a 30-second expiry. The worker never persists this cache or caches plaintext. Cached packets are authenticated again when consumed; speculative downloads alone do not produce HUD verification events. Lock and any expired-session response immediately clear the session's packets and pending downloads.

Closing or locking playback removes the worker session and aborts in-flight requests. If the browser terminates an idle service worker, a later media request can restore its session from the exact still-open owner window through a private MessageChannel. Restoration is bounded, coalesces concurrent requests, and refuses canceled or locked sessions. Active keys remain in browser memory, without keepalive traffic or persisted recovery state. Closing or reloading ends that active session; the public demo key can be supplied again through its prefill. This browser-local state does not require application-server affinity.

Playback preserves the original MP4 or WebM file, up to 2 GiB. Codec support depends on the browser. There is no server-side transcoding, FFmpeg processing, server media job queue, or generated preview. Synteq Apps hosts the Next.js service; no Serverless Functions are implemented.

The acceptance fixture is a prepared 90-second WebM containing 24,755,386 bytes across 24 chunks, with valid duration and cues for range checks. Fixture preparation does not represent a server-side transcoding path or support for additional media types.

### Browser compatibility

Firefox 157 reported four service-worker interception console errors alongside native byte-range cancellation during seeking (`NS_ERROR_PARSED_DATA_CACHED`). A controlled comparison reproduced the same four messages with only `respondWith(fetch(request))`, while direct HTTP playback produced none. Both paths decoded the 90-second sample and sought without a `MediaError`.

This observation separates a browser/service-worker console diagnostic from encrypted-chunk authentication. It does not establish that all Firefox console errors are harmless or claim a clean console across browsers. Actual media failures and failed authentication remain errors; native request cancellation must release the relevant stream without presenting failed decryption.

The source comparison is pinned to the [Firefox revision used by Playwright 1.64.1](https://github.com/microsoft/playwright/blob/v1.64.1/browser_patches/firefox/UPSTREAM_CONFIG.sh). Mozilla's [native media channel cancellation](https://github.com/mozilla-firefox/firefox/blob/fdd757a2e09c9471cddf383e64e631e4ce178499/dom/media/ChannelMediaResource.cpp#L697) and [failed service-worker body logging](https://github.com/mozilla-firefox/firefox/blob/fdd757a2e09c9471cddf383e64e631e4ce178499/dom/serviceworkers/FetchEventOpChild.cpp#L114) explain the relevant paths; the controlled playback result remains separate runtime evidence.

## Decryption activity

After successful AES-GCM authentication and length validation, the service worker sends a verification event to the exact session owner. The browser validates event origin, worker identity, session ID, chunk index, and expected byte count before recording it in memory.

The HUD reports unique verified chunks and MiB plus the last verified block. Repeated verification of a chunk advances its pulse revision without increasing unique byte or chunk coverage. Notifications are bounded to one every 200 ms; the UI keeps these updates nonurgent so they do not replace the native video element or cancel route transitions.

The display reserves 56 px at all states and uses at most 32 cells. It has no continuous idle spinner or simulated fetching/decrypting phases. Pulses correspond to verification events and are disabled under reduced-motion preferences. Activity contains no key, plaintext buffer, filename, or source URL and is cleared when playback closes or locks.

## Hosted object storage

`STORAGE_DRIVER=s3` selects one configured bucket and required `S3_PREFIX` namespace. Every replica uses it for the library descriptor, committed catalog, encrypted chunks, drafts, and deletion markers. Temporary app-local disk is not canonical state.

Chunk reads reuse up to 256 validated immutable manifests per object-store instance. The cache is an optimization, not a source of existence or deletion state: each encrypted packet read ends with a fresh shared tombstone lookup before any bytes are returned. A warm chunk therefore requires one packet GET and one tombstone HEAD. Request cancellation propagates through the storage adapter to pending SDK requests and response bodies. Catalog reads and mutations continue to consult durable storage.

Immutable object publication uses [R2 conditional creation](https://developers.cloudflare.com/r2/api/s3/extensions/#conditional-operations-in-putobject) with `If-None-Match: *`. Reads are bounded, and listing follows all object-list pages. Storage errors fail the request without switching backends or creating an empty replacement catalog.

Video deletion publishes an immutable marker under `tombstones/videos/<video-id>.json` before removing objects. Listing, reads, and finalization honor it, so concurrent completion cannot make the deleted video visible again. Retain these markers permanently during backup and maintenance. Interrupted cleanup or a racing upload can leave encrypted objects; repeating deletion can finish their removal without restoring the catalog entry.

## Local filesystem storage

`STORAGE_DRIVER=filesystem` requires a durable `STORAGE_PATH`. It contains `library.json`, `videos/<video-id>/` directories with drafts, committed manifests, and numbered encrypted chunks, and deletion markers under `tombstones/videos/`.

A temporary file is written and synced before a hard link publishes it atomically. Existing content cannot be replaced; retrying a chunk succeeds only when its bytes match. All processes must use the same filesystem with the required hard-link, rename, and sync semantics. Independent local disks are unsupported.

Filesystem deletion moves a committed video outside the catalog before removing its files. Interrupted deletion can leave encrypted files in `.trash`. The [draft maintenance script](deployment.md#local-filesystem-maintenance) handles expired unfinished uploads only.

## HTTP surface

| Endpoint | Purpose | Access |
| --- | --- | --- |
| `GET /api/health` | Validate configuration and exercise selected storage | Public |
| `GET /api/session` | Check convenience-session presence | Session cookie |
| `POST /api/session` | Open a session with `{}` | Matching origin |
| `DELETE /api/session` | Clear session cookie | Matching origin |
| `GET /api/library` | Read the encrypted descriptor or initialization state | Session |
| `POST /api/library` | Create the immutable encrypted descriptor | Writable mode, session, matching origin |
| `GET /api/videos` | List committed encrypted records | Session |
| `POST /api/videos` | Create an encrypted draft | Writable mode, session, matching origin |
| `PUT /api/videos/:id/chunks/:index` | Publish an encrypted chunk | Writable mode, session, matching origin |
| `POST /api/videos/:id/complete` | Publish a completed video | Writable mode, session, matching origin |
| `GET /api/videos/:id` | Retrieve a committed encrypted record | Session |
| `GET /api/videos/:id/chunks/:index` | Retrieve an encrypted chunk | Session |
| `DELETE /api/videos/:id` | Remove a committed video | Writable mode, session, matching origin |

Public demo mode returns `403` for all five library mutation routes while allowing sessions, reads, search, and playback. Schemas and body limits constrain writable requests. Session presence still does not establish ownership. See the [security limits](security.md) before exposing writable mode.

## Why this boundary

Provider-managed server-side encryption remains useful as an at-rest layer. It is not the application confidentiality boundary because the provider controls the managed keys for the objects it stores. R2 also automatically encrypts objects at rest with AES-256 and Cloudflare-managed keys; EEEVP uploads browser ciphertext first, so that provider layer protects ciphertext rather than plaintext media. A passive filesystem or object-store snapshot can still reveal identifiers, sizes, timestamps, and access patterns; without the private browser key it cannot directly recover names or media. The public demo is the deliberate exception because its demo key is published to viewers.

TLS protects the network hop. A passive observer who obtains TLS session material but not the private browser key still sees AES-GCM ciphertext in the application payload. Active endpoint compromise is different: malicious JavaScript, a compromised browser, or an unlocked device can capture keys or plaintext. EEEVP does not claim protection against that class of attack.

The current API's convenience session is a transport and workflow guard, not proof of key possession. Private writable mode therefore needs deployment-level access controls when mutation integrity or availability matters. Public demo mode returns `403` before all five library mutation routes and is the safe presentation mode for a known demo key.
