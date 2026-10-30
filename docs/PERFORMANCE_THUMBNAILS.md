# Thumbnail generation baseline

Run from the repository root with Node 20 and installed dependencies:

```sh
node node_modules/vite-node/vite-node.mjs --config vitest.config.ts scripts/benchmark-thumbnails.ts
```

The script creates PDFs with 16 short text lines per page, optionally drawing
the same generated 512 × 512 PNG on each page. It compares the former
uninterrupted loop with batches of four pages, using the engine renderer at
15% scale and the native test canvas. Every resulting JPEG data URL is compared
between the two runs. The first queued timer indicates how long this particular
run delayed other event-loop work; it is not a maximum latency guarantee.

One macOS arm64 Node 20.20.2 run gave:

| Pages | Fixture | Old total / timer delay | Batched total / timer delay |
| --- | --- | ---: | ---: |
| 10 | Text | 86.3 / 86.4 ms | 44.2 / 15.9 ms |
| 200 | Text | 719.2 / 721.1 ms | 680.6 / 12.7 ms |
| 10 | Text and image | 88.6 / 88.9 ms | 90.0 / 29.6 ms |
| 100 | Text and image | 813.3 / 814.7 ms | 647.4 / 28.3 ms |

These are single synthetic Node runs, influenced by warm-up, scheduling and
native canvas behavior. They do not establish browser input latency, image
decode cost for every image format, or worst-case per-page cost. A single page
can still block while it renders, and all thumbnails are still regenerated on
structural changes. Browser-level checks and real-world PDFs remain important.
