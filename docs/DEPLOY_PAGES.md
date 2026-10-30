# GitHub Pages demo

1. In repository **Settings > Pages**, set **Source** to **GitHub Actions**.
   Private repositories require a GitHub plan with Pages support; check access
   settings before publishing.
2. Push to `main`, or run **Deploy GitHub Pages** for `main` from the Actions
   tab. The deployment workflow installs dependencies, runs tests, builds and
   verifies `out/`, and deploys it to GitHub Pages. Only `main` can deploy.

The workflow obtains the configured site's base path from
`actions/configure-pages` and sets `NEXT_PUBLIC_BASE_PATH` at build time. A
project site normally uses `/<repo>`; a site at the domain root uses an empty
base path. Changing the site URL or prefix requires rebuilding and redeploying.

After deployment, the `smoke` job runs `scripts/smoke-pages.sh` against the
actual Pages URL. It checks the site root, `editor/`, `icon.png`, and
`brand/paperloom-logo.svg`, retrying temporary failures. A failed request or
non-200 response fails the job with the affected URL and HTTP status.

Always use `npm run build` (`next build --webpack`). Plain `next build` uses
Turbopack and can emit an unusable PDF worker; see [PDF_WORKER.md](PDF_WORKER.md).

## Local sub-path simulation

Use Node.js 22 and run from the repository root:

```bash
npm ci
NEXT_PUBLIC_BASE_PATH=/Paperloom-PDF npm run verify:release
```

Serve the export under the same prefix, not directly at the server root. For
example, stage it in a temporary directory and use a static HTTP server:

```bash
demo_dir=$(mktemp -d)
cp -R out "$demo_dir/Paperloom-PDF"
python3 -m http.server 8080 --directory "$demo_dir"
```

Open `http://localhost:8080/Paperloom-PDF/`. Upload a disposable PDF, open the
editor, and export text using a bundled font to check asset loading. Stop the
server and remove the temporary directory when finished.

`verify:base-path` scans the built `out/` HTML and JavaScript for unprefixed root
`/fonts/` and `/brand/` URL literals, including escaped URLs. Set
`NEXT_PUBLIC_BASE_PATH` to the value used for the build. Missing or empty output
fails the check; an empty base path skips it. This literal-URL guard does not
replace a browser navigation test. The deployment workflow checks the configured
Pages base path.

The initial offline cache includes the bundled fonts and OCR assets; the current
uncompressed assets occupy approximately 47 MiB. The separate
[CI workflow](../.github/workflows/ci.yml) provisions PDF interoperability tools
and Chromium, then runs release checks, coverage and the static E2E suite with
the `/Paperloom-PDF` prefix. It does not publish the output. Hosting settings,
workflow status and the deployed result must be verified on GitHub.
