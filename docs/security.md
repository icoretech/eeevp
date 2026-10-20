# Security model

EEEVP separates server authentication from browser encryption. The library password authorizes access to the private server. The master library key decrypts video keys in the browser. The normal application flow never sends plaintext encryption keys to the server.

## Two separate secrets

`LIBRARY_PASSWORD` grants access to the encrypted catalog, uploads, reads, and deletion through an eight-hour signed session cookie. It cannot decrypt video contents or filenames. All holders of this password belong to the same trusted library group; there are no individual accounts or per-user roles.

The library encryption key is a separate random 256-bit value. During explicit first-use initialization, the browser creates it and an encrypted verifier, then uploads only the immutable descriptor. Save the recovery key in a trusted password manager or another secure place before confirming initialization. The same key is required to unlock the library on another device.

The app keeps encryption keys in browser memory only. It does not put them in URLs, cookies, localStorage, or IndexedDB. Reloading requires entering the library key again. Locking clears in-memory library access, stops active uploads and playback, and clears the session cookie.

If sign-out cannot reach the server, the browser key still clears, but the cookie can remain authenticated. Retry sign-out when the connection is available.

Losing every recovery copy makes the videos unrecoverable. The server password, session secret, encrypted verifier, and filesystem backup cannot reconstruct the library key. There is no server-side key reset or recovery flow.

## Encrypted data

Each video has an independent random AES-256-GCM key. Video chunks and filename/media-type metadata are authenticated and encrypted with that key. The video key is then authenticated and encrypted under the master library key. The server stores the wrapped key, encrypted metadata, encrypted chunks, and structural metadata needed to retrieve them.

The library verifier detects an incorrect master key even when the catalog is empty. Key wrapping binds the library identity and video manifest. Chunk authentication binds the video context and chunk position. Modified, reordered, or substituted encrypted data fails authentication in the browser.

## Trust boundaries

The application origin and delivered JavaScript must be trusted. Malicious application code can read keys and plaintext inside an unlocked browser. A compromised browser, device, extension, or application deployment can also expose video contents. An authorized viewer can save or record a video it can decrypt.

The server observes video identifiers, sizes, chunk counts, creation dates, IP addresses, access timing, and authenticated sessions. It can withhold or delete encrypted files. Encryption authenticates contents but does not guarantee availability. This implementation has not undergone an independent cryptographic audit.

Anyone with the server password can issue deletion requests even without the encryption key. Keep that password restricted to trusted library users. Deleting a video removes it from live storage but cannot erase copies already held by an unlocked browser or retained in backups.

## Server access and hosting

Use independent random values for `LIBRARY_PASSWORD` and `SESSION_SECRET`. Cookies are HttpOnly, SameSite Strict, and Secure when `APP_ORIGIN` uses HTTPS. Mutations require an exact matching `Origin` header. Changing the session secret invalidates existing signed cookies. Changing only the library password does not invalidate cookies already issued.

The application has no per-user storage quotas or application-level login rate limiting. Protect the library password and apply ingress request limits appropriate for the audience.

- Use HTTPS for public access. Web Crypto and service-worker playback require a secure browser context; localhost is suitable for development.
- Restrict filesystem access and back up the complete storage directory, including the library descriptor and encrypted video keys. Keep the master-key recovery copy separately.
- Avoid analytics, error reporting, or logging that captures passwords, encryption keys, request credentials, or unlocked browser state.
- Preserve no-store API responses and service-worker cache headers through the reverse proxy.
- Monitor disk space and bandwidth. Follow the [offline draft cleanup procedure](deployment.md#clean-up-interrupted-uploads) when reclaiming interrupted uploads.
