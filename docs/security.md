# Security model

EEEVP encrypts before upload and decrypts in the browser. Private use keeps the encryption key secret on the client. The public read-only demo deliberately publishes its public samples' key through an editable prefilled field. The server does not validate the entered key; any nonempty value opens the workspace, while only the matching key decrypts content.

## Public demo and private use

`DEMO_MODE=true` requires a canonical `DEMO_PUBLIC_KEY`: an intentionally disclosed symmetric library key. It is runtime configuration delivered to the UI, not a secret or a private recovery key. Public demo mode returns `403` for library initialization, uploads, chunk writes, completion, and deletion before accessing library storage. Session operations, encrypted reads, local search, and playback remain available.

Use only public, non-sensitive demo media with clear creator and source credits. The known public key makes these samples readable by anyone using the prefill; encryption demonstrates the browser pipeline rather than making the sample content confidential.

Public availability does not put third-party media under the project's MIT license. Keep its creator and source credits and follow the [third-party notices](../THIRD_PARTY_NOTICES.md); do not reuse the demo key for private files.

The public gate exposes only the editable prefilled key and login. Private recovery-file import and key generation stay under the initially collapsed **Advanced key tools** in private mode.

Private use sets `DEMO_MODE=false` and requires a different private key and storage prefix or filesystem volume. Never reuse the public demo key or data namespace for private content, and never publish an existing private recovery key. Private mode does not expose the demo key through its UI configuration.

## Confidentiality boundary

Each video has an independent random AES-256-GCM key. Video chunks and filename/media-type metadata are authenticated and encrypted under it. The video key is then wrapped under the browser-held library key. Storage receives encrypted files, wrapped keys, and structural metadata needed to retrieve them.

A wrong key cannot unwrap video keys or decrypt filenames and content. The UI can still display the encrypted catalog, including sizes and creation dates. It leaves names unreadable and videos unplayable. Before an upload, the browser must be able to decrypt the existing library descriptor; this is a local guard against using a wrong key for new content.

Private keys and imported recovery files are not sent in URLs, headers, cookies, or request bodies. Active playback keys remain in browser memory, without localStorage or IndexedDB persistence. Locking clears active key state and playback. Private use requires supplying the key again after reload; the public demo's intentionally known key remains available in its prefill.

Keep a private recovery copy separately in a trusted place. Losing every copy makes private videos unrecoverable; server configuration, encrypted metadata, and backups cannot reconstruct that private key. Use a random 32-byte private key encoded as canonical unpadded base64url. The public demo key is recoverable from its deliberately public configuration.

## Session and mutation limits

`POST /api/session` accepts an empty JSON object and opens a signed HttpOnly convenience session. It receives no key and establishes no key possession. Any caller can obtain this session.

Cookies are SameSite Strict and Secure for an HTTPS origin. Mutations require an exact matching Origin header. These guards support the browser workflow and mitigate cross-site request submission; they do not establish library ownership.

The `same-origin` referrer policy suppresses referrers to other origins while preserving the Origin header on same-origin mutations, including in Firefox-based browsers. Keys never appear in URLs.

The decryption HUD receives only session-scoped verification metadata: chunk index and authenticated byte count. Its in-memory counters deduplicate verified coverage and contain no keys, plaintext, names, or source URLs. Locking or closing playback clears them; the HUD does not persist or send analytics.

Playback may reuse encrypted packets from worker memory for up to 30 seconds, with limits of 8 MiB per session and 32 MiB for the worker. Expiry is checked lazily on access; it limits reuse rather than promising timed memory erasure. This is not HTTP, disk, localStorage, IndexedDB, or Cache Storage persistence. Cached packets are authenticated when used, and closing/locking the session or receiving HTTP 401 clears its cache and in-flight reads immediately. Until expiry or an uncached request, already fetched ciphertext can still be consumed, just as the native decoder can retain already buffered media; remote deletion or cookie expiry cannot revoke bytes already delivered to a browser. Every new server chunk response checks the durable deletion marker after reading the packet, even when its immutable manifest is cached.

In public demo mode, server guards reject all library mutations regardless of the entered key or session. In writable private-use mode, a caller with an opened session can invoke create, upload, and deletion APIs without the encryption key. The browser's upload guard can be bypassed by a direct API caller. Do not treat that session as strong write authorization; exposing writable mode to untrusted callers requires a separate deployment-level access policy.

For a private key unknown to an attacker, AES-GCM detects altered ciphertext. It cannot prevent deletion, denial of service, bogus records, or storage exhaustion in writable mode. The public key provides no confidentiality or forgery protection against a key holder; server read-only guards protect the public dataset from library API mutations. Immutable publication and deletion markers preserve record semantics across replicas, without identifying an authorized owner. Backups and browser-held copies can outlive deletion.

## Application and device trust

The application origin and delivered JavaScript must be trusted. Malicious application code can read keys and plaintext from an unlocked browser. A compromised browser, device, extension, or application deployment can expose content. A viewer that can decrypt a video can save or record it.

The server and storage provider can observe video identifiers, sizes, chunk counts, creation dates, request timing, and sessions. The ingress also observes client network addresses. With a secret private key, ciphertext protects content held by passive storage; it does not protect against malicious code delivered to the browser. Public demo content is deliberately readable. This implementation has not undergone an independent cryptographic audit.

## Transport and storage references

EEEVP's browser packet format follows the [W3C Web Cryptography specification](https://www.w3.org/TR/WebCryptoAPI/) AES-GCM model and uses authenticated additional data for manifest context and chunk index. HTTPS is required because [TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446) protects transport against eavesdropping, tampering, and message forgery; TLS does not replace application-layer encryption.

The storage provider receives already-encrypted application payloads. [Amazon S3's encryption overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingEncryption.html) distinguishes server-side encryption, where the service encrypts objects at rest and decrypts them on download, from client-side encryption, where the client manages the encryption process and keys. [Cloudflare R2's data-security documentation](https://developers.cloudflare.com/r2/reference/data-security/) states that R2 automatically encrypts all objects and metadata at rest with AES-256 and Cloudflare-managed keys. EEEVP adds its own client-side AES-GCM layer before R2 receives an object, so provider-managed at-rest encryption protects ciphertext rather than plaintext media. A passive snapshot can retain structural metadata, but it cannot directly recover private names or media without the private browser key. The public demo intentionally publishes its key.

## Hosting

Keep R2 credentials server-side and scope them to the single configured private bucket. All canonical records, including deletion markers, must survive restarts in that bucket. Local development uses its persistent filesystem volume. Storage failures must not create fallback state elsewhere.

Use an independent random `SESSION_SECRET`; rotating it clears the validity of existing cookies without changing encrypted content. Never put a private encryption key into server environment files or the hosted container. `DEMO_PUBLIC_KEY` is the explicit intentionally public exception for the isolated read-only public demo.

Use HTTPS, preserve no-store API responses and service-worker cache headers, and avoid logging keys, recovery-file contents, or unlocked browser state. Back up the complete canonical storage namespace while keeping the recovery key separately. See the [deployment guide](deployment.md) for configuration and maintenance.

`/robots.txt` requests no crawling with `User-Agent: *` and `Disallow: /`; page metadata requests `noindex, nofollow`. These directives do not authenticate callers or restrict content access.
