# PDF worker architecture

`PDFDocumentData` remains the authoritative, mutable document on the main thread. The worker never receives that object directly: `codec.ts` encodes its class graph as an explicit node-ID wire graph, preserving aliases, maps, references, streams, pages, and trailer data. The client hydrates responses into real PDF classes and prototypes.

Parsing runs in the worker and hydrates on the main thread. Save and optimize encode a snapshot first; the worker hydrates that snapshot, so optimization's garbage collection and deduplication do not mutate the live document. Byte buffers sent to the worker are copies before transfer.

Snapshot encoding still requires main-thread traversal and byte copying. PWA-005 therefore moves parse and serialization CPU off-thread but does not claim zero main-thread work.

When the environment has no `Worker` API, the client uses the existing parser and writer directly for compatibility. If worker construction fails, a request fails, or a worker crashes or times out, the operation reports an error instead of replaying the same document on the UI thread. A crashed, malformed-response or unresponsive worker is terminated; later requests create a new worker. Each request has a 60-second timeout. Static hosting remains supported because the worker is emitted through the bundler using `new URL('./pdf.worker.ts', import.meta.url)`.

The production `build` script intentionally uses `next build --webpack` as a temporary constraint. With Next 16.2.11, Turbopack static export currently treats this `new URL('./pdf.worker.ts', import.meta.url)` pattern as a raw media asset (`pdf.worker.<hash>.ts`) containing uncompiled TypeScript. Webpack emits a compiled executable worker JavaScript chunk instead. The PDF-worker guard checks static exports for both conditions.

Quick saves use one combined wire graph for `document.objects` and `newObjects`; `newObjectKeys` identifies the incremental subset. This preserves aliases between the two maps. After a successful worker quick save, the client applies the legacy incremental writer side effect by adding those objects to the live document and advances live `rawBytes` only when the incremental writer advanced the worker document's `rawBytes`. Full serialization and fallback saves do not blindly update it. When the environment has no `Worker` API, optimized direct execution uses a fresh snapshot so garbage collection and deduplication cannot mutate the live document.
