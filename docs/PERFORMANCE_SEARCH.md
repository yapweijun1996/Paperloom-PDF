# Search performance baseline

Run from the repository root with Node 20 and the installed dependencies:

```sh
node --expose-gc node_modules/vite-node/vite-node.mjs --config vitest.config.ts scripts/benchmark-search.ts
```

The script generates PDFs with pdf-lib and Helvetica, using 16 lines per page.
The scan cases additionally embed a separate copy of the public-domain National
Archives image on each page; see [fixture provenance](../src/engine/__tests__/golden/fixtures/README.md).
It parses each generated PDF and compares the former full-page interpretation on every query with the search index, including snapshot validation on warm queries. It also measures the delay to a queued timer and reports estimated retained index size and process memory deltas. Those memory readings are approximate, affected by garbage collection, and include live search results and snapshots; rerun on the target system rather than treating them as precise allocations.

One local run on macOS arm64 with Node 20.20.2 produced:

| Pages (PDF size) | Matches | Old scan | Indexed cold | Indexed warm median | Timer delay, old → cold | Estimated index |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 (12,046 bytes) | 160 | 19.0 ms | 23.1 ms | 2.3 ms | 20.2 → 11.4 ms | 142,148 bytes |
| 200 (225,243 bytes) | 3,200 | 241.0 ms | 274.3 ms | 24.0 ms | 241.1 → 16.8 ms | 2,921,296 bytes |

For the 200-page run, the observed post-GC heap delta was 3,393,208 bytes and ArrayBuffer delta was 2,997,466 bytes. The smaller heap reading was dominated by measurement noise. This is one local synthetic run, not a latency guarantee. Cold searches perform extra validation and can take longer overall while allowing the browser to process input between pages.

At the time of that baseline, the index used an estimated 32 MiB retained-data limit and cached only when a document graph fit an estimated 8 MiB full-snapshot budget. Larger graphs were searched without caching or intermediate yields so changes could not interleave with a scan. A single expensive page and graph validation can still block the main thread. The first table measures only text PDFs; it does not measure image-heavy searches or end-to-end browser memory.

An additional clean-install Node 20.20.2 run on the same macOS arm64 host used
independent copies of the 508,711-byte scan image on each page:

| Pages (PDF size) | Matches | Old scan | Indexed cold | Indexed warm median | Timer delay, old → cold | Estimated index |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 (5,101,772 bytes) | 160 | 14.1 ms | 14.1 ms | 15.0 ms | 14.1 → 14.2 ms | 0 bytes |
| 40 (20,404,543 bytes) | 640 | 67.5 ms | 59.8 ms | 53.3 ms | 67.6 → 59.9 ms | 0 bytes |

Both image-heavy cases exceeded the full-snapshot budget and therefore used
the synchronous uncached fallback in that baseline. The timer delay reflects that behavior; the
single measurements do not establish an image-heavy speedup. Image decoding and
browser memory were not measured. Thumbnail and history measurements are in
[PERFORMANCE_THUMBNAILS.md](PERFORMANCE_THUMBNAILS.md) and
[PERFORMANCE_HISTORY.md](PERFORMANCE_HISTORY.md).

A repeat after the text-paint changes measured 40 scan pages at 62.7 ms old,
62.9 ms cold, 57.8 ms warm median, and 62.8 → 62.9 ms timer delay; the index
remained uncached. This is another single Node run, not a browser measurement.

Two isolated experiments retained complete byte comparisons while increasing
the snapshot budget. One 40-page run yielded a 13.9 ms timer delay but took
112.5 ms cold and retained about 20.9 MB of ArrayBuffers, versus 69.5 ms for
its old synchronous scan; warm median was 54.2 ms. Another attempt was slower
still. These are exploratory single runs rather than a controlled benchmark;
neither implementation was adopted because overall latency and memory did not
justify it. Those experiments did not establish a browser improvement; the
later image-fingerprinting measurement is described below.

## Image fingerprinting in browser search

Text-only page and Form interpretation now skips the image-resource versions
used by image replacement. The ordinary interpreter still computes those
versions. To compare both paths on the same synthetic scan fixture in Chrome:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/path/to/Chrome' node scripts/benchmark-search-browser.mjs --pages 40 --samples 3
```

The script requires the installed development dependencies, uses the same
public-domain scan image, alternates the two modes, validates the match count,
and deletes its temporary local server files. It caps the fixture at 40 pages
and five samples. The old-mode comparison enables image fingerprints on the
current interpreter; it is not a separate historical build. The fixture has no
Form XObjects.

On one macOS arm64 machine with Node 20.20.2 and headless Chrome 156, a
20,402,619-byte fixture returned 640 matches in every run. Three interleaved
samples measured median elapsed times of 606.5 ms with fingerprints and
21.7 ms without; corresponding timer delays were 606.6 ms and 21.8 ms. A
separate run under lighter load measured 272.6 ms and 10.1 ms. These are
synthetic single-machine measurements, not a latency guarantee. The sampled
sum of browser-process RSS was about 996 MiB before the combined run and
1,089 MiB at its observed peak; it includes fixture setup, can double-count
shared pages and cannot compare memory between the modes. A structure or dependency budget overflow still falls back to an uncached
synchronous scan, so a single large text operation can still block input. See [BUG-169](../BUG.md#bug-169-image-heavy-search-falls-back-to-a-synchronous-full-scan).

## Cooperative search on an over-budget image graph

A search-specific snapshot now copies structure and only the stream bytes that
text extraction actually reads. It validates those dependencies before publishing
or caching results. Unverifiable custom PDF objects are rejected; if the
structure or accessed streams exceed their budgets, search falls back to the
existing synchronous path. This does not bound a single expensive page.

Run the synthetic scheduling comparison with:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH='/path/to/Chrome' node scripts/benchmark-search-scheduling.mjs --pages 40 --samples 3
```

The comparison uses the current code for both modes, not a historical build.
Its synchronous mode allocates an additional 8,388,609-byte unused
`encryptionFileKey` to trigger the snapshot budget fallback; the same browser
holds it during both modes. It alternates modes, validates 640 matches and
geometry, then measures cold and repeated searches. One local macOS arm64 run
with Chrome 156 and Node 20 on the 20,402,619-byte synthetic fixture yielded:

| Mode | Cold elapsed median | Cold maximum event-loop gap median | Repeated elapsed median | Retained index |
| --- | ---: | ---: | ---: | ---: |
| Forced synchronous fallback | 22.3 ms | 22.3 ms | 21.8 ms | 0 bytes |
| Cooperative snapshot | 41.6 ms | 13.6 ms | 8.3 ms | 522,128 bytes |

These are three samples per mode on one machine; cold elapsed time increased
while the measured longest gap and repeated-query time decreased. Sampled
browser-process RSS for the combined run was approximately 997 MiB at baseline
and 1,119 MiB at peak; shared pages may be counted multiple times and this
combined sample cannot compare memory by mode. This is not evidence of a
memory improvement or a general latency guarantee.
