# Static deployment and local signature privacy

This is an assessment of the current source, not a claim that a deployed site
has these protections. This checkout builds static files (`output: 'export'` in
[next.config.ts](../next.config.ts)); it does not configure a CSP response header
or CSP meta element. The actual hosting and response headers have not been
verified. Check the deployed HTML **and worker-script responses** before relying
on a policy. A static export alone cannot issue its own HTTP response headers.

## Content Security Policy deployment

A hosting layer capable of setting response headers can test a candidate policy
with `Content-Security-Policy-Report-Only`, using synthetic documents and a
privacy-reviewed report destination. Then enforce only after checking all critical
flows. Report-only is not supported through a CSP meta element; `frame-ancestors`
also requires a response header. Browser and server policy details are described
in [MDN's CSP guide](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP)
and [frame-ancestors reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors).
A host without configurable response headers would need a proxy/CDN or a
reduced-capability meta policy; do not assume either exists here.

The following are inputs to a policy design, **not a tested or deployable header**:

- The exported Next.js pages include inline scripts, including the theme
  initializer in [layout.tsx](../src/app/layout.tsx). Inventory and hash the exact
  inline script bodies for each production build, or use a server-generated
  nonce if a dynamic hosting layer is introduced. Test hydration on every route;
  broadly allowing inline script weakens the intended XSS protection.
- React components also use inline style properties; a strict style policy must
  account for those properties and be tested in supported browsers. Image previews
  and signatures use `data:` URLs, and selected-image previews and downloads can
  use `blob:` URLs. Permit only the schemes and directives needed by verified
  flows; these schemes are not a substitute for validating input.
- The PDF engine creates a same-origin module worker
  ([client.ts](../src/engine/worker/client.ts)); offline registration loads a
  same-origin service worker ([ServiceWorkerRegistration.tsx](../src/app/ServiceWorkerRegistration.tsx)).
  OCR loads its worker, runtime and English language model from the application
  origin ([adapter.ts](../src/lib/ocr/adapter.ts)); the static export precaches
  these assets for offline use. HarfBuzz text shaping uses a bundled
  WebAssembly asset ([shaping.ts](../src/engine/fonts/shaping.ts)); a policy may
  need the narrower `'wasm-unsafe-eval'` expression in browsers that support it.
  Do not add general `'unsafe-eval'` merely to make an untested policy work.
  [MDN documents worker-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/worker-src),
  [worker response policies](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Using_web_workers#content_security_policy),
  and [WebAssembly CSP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src#unsafe_webassembly_execution).
- Fonts may be fetched from the application's own base path. Optional RFC 3161
  timestamping posts a signature digest and nonce to configured TSA endpoints;
  the current default fallback list contains `https://freetsa.org` and
  `https://timestamp.digicert.com`
  ([timestamp-client.ts](../src/engine/signatures/timestamp/timestamp-client.ts)).
  Timestamping needs network access and may fail because of browser CORS or
  availability. Allowing external origins also grants them the
  corresponding capabilities and exposes normal connection metadata such as IP.
- Consider restrictive `base-uri`, `object-src`, `form-action` and
  `frame-ancestors` where compatible with the deployment. `connect-src` alone
  cannot prevent every possible exfiltration path. Recheck browser-specific
  behavior, worker response policies, bundled data URLs, generated assets and
  every release; CSP does not replace output encoding or trustworthy code.

No candidate header, CSP violation collection, alternate host or live deployment
was installed or verified by this assessment. Before enforcement, exercise at
least upload, text/image editing, signing, downloads, offline recovery, shaping,
OCR and timestamp success/failure under the **actual** host, base path, browser
and worker policies. Inspect report data for sensitive URLs before retaining or
sending it to a third party.

## Visual signature storage

New drawn, typed or uploaded visual signatures default to an in-memory library
entry for the current session. Users can instead choose to save an entry on the
device. Existing saved entries remain in place. [library.ts](../src/engine/signatures/visual/library.ts)
stores device entries, including name, image data URL, dimensions, source,
timestamps and optional typed text and style, under the
`bloom-pdf-signature-library-v1` **localStorage** key. The application does not
encrypt these entries, even when the open PDF has a password. Same-origin
scripts, shared browser profiles, extensions, backups and a compromised
host/browser may expose them. A failure to save is shown to the user and a new
entry remains available in memory for the session. Session-only applies to the
reusable library, not to a signature already placed in a PDF or its recovery data.

The user can remove a library entry in the editor, or clear site data in the
browser. This removes the application's current reference; it does not guarantee
erasure of already exported PDFs, copies in document/recovery data, browser
backups or other retained copies. Deleting a signature from the library is not a
cryptographic revocation of a previously signed or exported document.

Visual signatures are distinct from cryptographic keys. The certificate manager
keeps imported private key material in the current process memory and persists
only public certificate metadata to localStorage
([certificate-manager.ts](../src/engine/signatures/certificates/certificate-manager.ts)).
Password-authenticated P12/PFX import supports PBES2 AES-CBC and verifies the
container MAC before decrypting, then checks the private key against the selected
certificate. Imported WebCrypto private keys are non-extractable. Legacy
3DES/RC2 encryption, files without a supported MAC, and oversized or costly
inputs are rejected; the limits and supported algorithms are documented in
[pkcs12-protected.ts](../src/engine/signatures/certificates/pkcs12-protected.ts).
An intact container does not establish certificate-chain trust or revocation.
The IndexedDB document/recovery flow is separate; password-protected document
recovery overlays use the encryption described in
[recoveryEncryption.ts](../src/lib/recoveryEncryption.ts), but this does not
protect device-saved library entries. A user-unlocked encrypted signature library
would require separate key-management, migration and recovery design; silently
deleting or encrypting existing entries would risk data loss.
