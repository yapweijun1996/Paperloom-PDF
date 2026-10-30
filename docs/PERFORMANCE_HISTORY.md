# History memory baseline

Run with Node 20, installed dependencies, and explicit garbage collection:

```sh
node --expose-gc node_modules/vite-node/vite-node.mjs --config vitest.config.ts scripts/benchmark-history.ts
```

The script creates synthetic PDFs with 16 short text lines per page. The image
case draws the same generated 512 × 512 PNG on every page; it does not measure
image decoding, thumbnail generation, or browser memory. It captures ten
`EditorHistory` entries and then eleven `DocumentSession` byte snapshots (the
initial state plus ten additions), and checks undo/redo in each implementation.
It measures these structures separately; an actual editor session may retain
both and other allocations at the same time. No page editing or save/reopen
behavior is benchmarked.

One macOS arm64 Node 20.20.2 run gave:

| Pages | Fixture | PDF bytes | Ten entry captures | Captured content bytes | Eleven byte snapshots |
| --- | --- | ---: | ---: | ---: | ---: |
| 10 | Text | 11,455 | 3.4 ms | 251,630 | 0.2 ms |
| 200 | Text | 213,823 | 20.7 ms | 4,684,600 | 0.4 ms |
| 10 | Text and image | 365,164 | 1.3 ms | 261,720 | 0.4 ms |
| 100 | Text and image | 466,725 | 15.7 ms | 2,429,200 | 0.4 ms |

Captured content bytes are the actual `contentBytes` arrays in those entries,
including the extra current-page copy; they exclude cloned object graphs and
other overhead. Eleven byte snapshots retain approximately eleven copies of
the PDF bytes; the benchmark's undo/redo results temporarily retain additional
copies. Process heap and ArrayBuffer deltas are also emitted, but may include
garbage-collection timing and unrelated allocations; negative deltas are not
negative memory consumption. Results are single synthetic runs, not latency or
memory guarantees. Larger real-world files, editing behavior, browser heap and
the maximum 50-entry histories remain to be measured.
