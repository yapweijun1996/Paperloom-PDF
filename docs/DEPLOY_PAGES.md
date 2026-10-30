# GitHub Pages demo

This checkout contains a GitHub Actions CI workflow for tests and a local static
build, but no deployment workflow. The repository's actual deployment mechanism
and Pages settings have not been verified. Do not assume that pushing to `main`
publishes this checkout or performs a post-deployment smoke test.

A static build can be prepared locally using `NEXT_PUBLIC_BASE_PATH=/<repo>`
for a project Pages URL, or an empty value for a site hosted at the root. The
prefix is fixed at build time. If a deployment workflow is added later, it
should run `scripts/smoke-pages.sh` against the deployed URL and report failed
requests; this script is currently not connected to a workflow in this checkout.

Always use `npm run build` (`next build --webpack`). Plain `next build` uses Turbopack and can emit an unusable PDF worker; see [PDF_WORKER.md](PDF_WORKER.md).

## Local sub-path simulation

Use Node.js 22 and run from the repository root:

```bash
npm ci
NEXT_PUBLIC_BASE_PATH=/bloom-pdf-editor npm run verify:release
```

Serve the export under the same prefix, not directly at the server root. For example, stage it in a temporary directory and use a static HTTP server:

```bash
demo_dir=$(mktemp -d)
cp -R out "$demo_dir/bloom-pdf-editor"
python3 -m http.server 8080 --directory "$demo_dir"
```

Open `http://localhost:8080/bloom-pdf-editor/`. Upload a disposable PDF, open the editor, and export text using a bundled font to check lazy asset loading. Stop the server and remove the temporary directory when finished.

`verify:base-path` scans the built `out/` HTML and JavaScript for unprefixed root `/fonts/` and `/brand/` URL literals, including escaped URLs. Set `NEXT_PUBLIC_BASE_PATH` to the same value used for the build. Missing or empty output fails the check; an empty base path skips it. This is a literal-URL guard, not a browser navigation test or an evaluator of arbitrary computed URLs. Run this check for each prefix used to publish an export.

The bundled fonts total approximately **29 MiB**. They are fetched lazily when needed, not downloaded on the initial page load.

The [CI workflow](../.github/workflows/ci.yml) provisions the PDF interoperability
tools and Chromium, then runs release checks, coverage and the static E2E suite
with the `/Paperloom-PDF` prefix. It does not publish the output. The workflow has
been statically validated but has not yet been observed on a GitHub runner.
