# Browser save performance

The save benchmark builds the current source into a temporary local browser
fixture. It generates a PDF containing one large uncompressed blank content
stream, applies a page rotation, saves an incremental revision through the
direct engine or a real Worker, and verifies the downloaded bytes by reopening
them. It does not open or transmit the user's PDFs.

After `npm ci`, run with an installed Chrome or a Playwright-managed Chromium:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/path/to/Chrome' node scripts/benchmark-save-browser.mjs --size-mib 20 --samples 3
```

Use `--mode direct` or `--mode worker` for one path, and `--new-objects` to
include an explicitly supplied new object. `--source-root PATH` selects an
isolated checkout with its dependencies already installed, allowing the same
benchmark script to compare two versions. `--help` lists limits and options.
The script prints one JSON line per sample and removes its temporary files.
Inputs are capped at 32 MiB and ten samples to limit resource use.

The reported heartbeat is the largest observed gap during the save; it is not
a complete frame-latency profile. Process RSS is sampled through Chrome DevTools
and `ps`, includes fixture setup and reopening, and may double-count shared
pages. A missing RSS value means sampling was unavailable. JS heap statistics do
not include every external buffer. Results depend on hardware, browser, system
load, document structure and garbage collection.

## Preliminary comparison

On macOS, Node 20.20.2 and Chrome 156, a separate temporary harness alternated
three before/after runs using a 20 MiB synthetic blank stream and no new object.
The median direct save time was 1,038 ms before and 940 ms after; median worker
save time was 1,093 ms before and 1,169 ms after. Median observed heartbeat gaps
were 1,038 and 940 ms for direct, and 102 and 88 ms for worker. The temporary
harness kept heartbeat monitoring active during output reopening, so those gaps
may include work after save; the committed script stops monitoring before
verification. Individual timings varied substantially. Sampled RSS sums ranged
from approximately 1.4 to 1.7 GiB across both versions and do not demonstrate
a memory improvement.

The change avoids a redundant combined-document snapshot when new objects do
not change the object map, and omits decoded stream caches from snapshots used
only for equality checks. Worker messages and comparison baselines retain
independent byte copies. This small synthetic comparison does not establish a
real-document improvement or resolve [BUG-207](../BUG.md#bug-207-large-pdf-incremental-saves-can-block-the-editor-and-use-substantial-memory).
Representative documents, repeated measurements on target hardware, and peak
memory accounting remain needed.
