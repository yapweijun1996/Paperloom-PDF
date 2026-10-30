# Static build end-to-end tests

The suite launches an isolated local static server and a fresh browser context.
It uses generated PDF and self-signed certificate fixtures; no existing documents
or credentials are required. The signature test checks mathematical validity
with `pdfsig`, not trust in the temporary self-signed certificate.

Requirements: the project's supported Node.js version, installed npm dev
dependencies, Chromium installed by Playwright (`npx playwright install chromium`)
or a Chromium executable selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`,
plus `openssl`, `qpdf`, `pdftotext`, `pdftoppm`, and `pdfsig` on `PATH`. The SVG
transparency tests use `pdftoppm` to check pixels with an independent PDF
reader; the redaction tests use `qpdf` and `pdftotext` to check saved output.
Missing tools or a missing browser fail the suite instead of skipping checks.

Build the exported application first and pass the same base path to both commands:

```sh
NEXT_PUBLIC_BASE_PATH=/Paperloom-PDF npm run build
NEXT_PUBLIC_BASE_PATH=/Paperloom-PDF npm run test:e2e
```

Omit `NEXT_PUBLIC_BASE_PATH` from both commands for a root deployment. The server
binds to `127.0.0.1:4179`; set `PAPERLOOM_E2E_PORT` to use another available port.
A mismatch between the build's base path and the test base path causes the tests
to fail. `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` can point to a locally installed
Chrome or Chromium when the Playwright-managed browser is unavailable.

The repository CI workflow runs this suite against its static subpath build after
the release checks. Its first hosted GitHub Actions run has not been verified.
