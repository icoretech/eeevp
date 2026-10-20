# Architecture

EEEVP is a private authenticated video library. One Next.js application serves an encrypted catalog and video chunks from a durable filesystem. The browser owns the master library key, decrypts the catalog, and plays the videos.

## Authentication and library initialization

The server password grants access to the library through an eight-hour signed, HttpOnly session cookie. All catalog, video, and chunk requests require that cookie. Mutations also require the configured application origin.

The library encryption key is separate: a random 32-byte value generated in the browser. On first use, the authenticated user explicitly creates the key, saves a recovery copy, and confirms initialization. The browser creates an encrypted verifier bound to a library identifier and format version. The server atomically creates the immutable library descriptor containing that verifier, without receiving the master key.

An initialized library requires the same master key on every device. The browser verifies the entered key against the descriptor before displaying decrypted videos or enabling uploads. The key stays in browser memory across application navigation. Reloading requires entering it again. Locking clears the key, stops active browser work, and clears the session cookie.

## Encrypted catalog

The server lists committed video records from the filesystem. Each record contains its encrypted manifest, an encrypted per-video key, library identifier, and server-generated creation date. The server is the canonical catalog for every authenticated device.

The unlocked browser decrypts each per-video key under the master library key, then authenticates and decrypts its filename and media type. Search operates on these decrypted filenames locally. The application does not persist the master key, decrypted catalog, or per-video keys in browser storage.

The key wrapper uses AES-256-GCM with a fresh 12-byte IV and 16-byte authentication tag. Its associated data binds the library identifier and complete validated video manifest, preventing a wrapped key from being substituted into another video record.

## Upload

1. The unlocked browser passes the selected file, library descriptor, and in-memory master key to a dedicated web worker.
2. The worker verifies the library key, generates a random video identifier and independent 256-bit video key, and encrypts filename and media type.
3. It encrypts the video key under the library key and sends the manifest, wrapped key, and library identifier to create an authenticated upload draft. Plaintext keys are excluded from the server request schema.
4. The worker reads, encrypts, and uploads one 1 MiB chunk at a time. Each packet contains a random 12-byte IV, ciphertext, and a 16-byte authentication tag.
5. The server publishes the completed record after every chunk is present with its expected length. The browser reads the committed record back and refreshes the catalog.

AES-GCM authentication binds metadata to the video identifier, size, chunk size, and chunk count. Chunk authentication additionally binds the chunk index and encrypted metadata. Reordered, substituted, or altered packets fail browser authentication.

The worker is terminated after completion, failure, cancellation, or locking. An unpublished upload cannot be read through the normal video API.

## Playback

Opening `/watch/:id` requires authentication and an unlocked browser library. The browser fetches the encrypted video record, unwraps its video key, and decrypts its metadata locally.

A service worker creates an in-memory playback session bound to the initiating browser client. The native video element requests its virtual media URL using ordinary byte ranges. The worker fetches encrypted chunks through the authenticated API, verifies and decrypts them, then streams the requested plaintext bytes to the browser's media decoder.

Closing or locking playback removes its worker session and aborts in-flight chunk requests. A service worker restart loses active playback state; reopening the video restores it. This in-memory state lives in the browser and does not require server affinity.

Playback preserves the original file. MP4 and WebM MIME types are accepted up to 2 GiB; codec support depends on the browser. There is no transcoding or server-generated preview.

## Persistent files and deletion

`STORAGE_PATH/library.json` holds the immutable library descriptor. Under `STORAGE_PATH/videos`, each video directory contains `draft.json`, a committed `manifest.json` when complete, and numbered ciphertext files in `chunks/`.

Draft and committed records contain only the encrypted manifest, wrapped video key, library identifier, and creation date. A temporary file is written and synced before a hard link atomically publishes it. Existing content cannot be replaced; uploading the same chunk again succeeds only if the packet matches exactly.

Every server process must use the same durable filesystem with the required hard-link, atomic rename, and sync semantics. Independent hosts with separate disks are unsupported. Keep one application service on one persistent server unless shared filesystem behavior has been verified.

Video deletion requires an authenticated, same-origin request and explicit confirmation in the UI. The server atomically moves the committed video's directory to `STORAGE_PATH/.trash` before removing its files. Other clients see the deletion when they refresh their catalog or request the video again. A crash after the move can leave encrypted files outside the catalog until operator cleanup. Retained backups require their own retention policy. Deletion never removes the library descriptor.

Canceled uploads can leave unpublished files. An operator can remove expired drafts with the [offline maintenance procedure](deployment.md#clean-up-interrupted-uploads). There is no automatic retention cleanup or resumable upload workflow.

## HTTP surface

| Endpoint | Purpose | Access |
| --- | --- | --- |
| `GET /api/health` | Validate configuration and write/sync a temporary storage file | Public |
| `GET /api/session` | Check library session | Session cookie |
| `POST /api/session` | Sign in | Library password and matching origin |
| `DELETE /api/session` | Clear session cookie | Matching origin |
| `GET /api/library` | Read the descriptor or initialization state | Library session |
| `POST /api/library` | Create the immutable descriptor | Library session and matching origin |
| `GET /api/videos` | List committed encrypted video records | Library session |
| `POST /api/videos` | Create an encrypted upload draft | Library session and matching origin |
| `PUT /api/videos/:id/chunks/:index` | Publish an encrypted chunk | Library session and matching origin |
| `POST /api/videos/:id/complete` | Publish a completed video | Library session and matching origin |
| `GET /api/videos/:id` | Retrieve a committed encrypted record | Library session |
| `GET /api/videos/:id/chunks/:index` | Retrieve an encrypted chunk | Library session |
| `DELETE /api/videos/:id` | Permanently remove a committed video | Library session and matching origin |

JSON request schemas reject extra fields. Requests and file reads are bounded. Unauthenticated video requests return 401; absent videos return 404. Readiness checks storage access, without decrypting or validating every saved video.
