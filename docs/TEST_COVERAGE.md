# Test coverage baseline

Run `npm ci` followed by `npm run test:coverage` with a supported Node version. The command runs the same external-tool preflight as `npm test`, then runs the full Vitest suite with Istanbul instrumentation. The report appears in the terminal and in `coverage/coverage-summary.json`; generated reports are not committed.

Coverage includes all `src/**/*.ts` and `src/**/*.tsx` files, including files that no test imports. Test files, `__tests__` directories and type declarations are excluded. These are global floors; individual files can have lower coverage. Coverage measures executed code, not the quality of assertions or browser end-to-end behavior.

The initial baseline below was measured on 2026-10-30 with Node 20.20.2 on macOS arm64, using the full suite after a clean install: 181 test files passed, 1,989 tests passed and one test was skipped because qpdf was unavailable locally. Subsequent source changes can alter these figures.

| Metric | Covered / total | Baseline | Global floor |
| --- | ---: | ---: | ---: |
| Statements | 21,531 / 35,847 | 60.06% | 60% |
| Branches | 13,012 / 24,513 | 53.08% | 54% |
| Functions | 2,503 / 4,137 | 60.50% | 61% |
| Lines | 18,780 / 30,036 | 62.52% | 63% |

A later full run on the same platform passed 2,061 tests with one qpdf skip,
and measured 60.61% statements, 53.78% branches, 60.78% functions and 63.08%
lines. The floors above were raised after that run.

A subsequent full run passed 2,100 tests with one qpdf skip and measured
60.83% statements, 54.07% branches, 60.91% functions and 63.28% lines.
A later full run passed 2,136 tests with one qpdf skip and measured 61.17%
statements, 54.55% branches, 61.39% functions and 63.65% lines. The latest
CI-mode run used a temporary qpdf 12.4.2 build, passed 2,202 tests without skips,
and measured 61.36% statements, 54.85% branches, 61.63% functions and 63.85%
lines. A newer clean CI-mode run passed 2,321 tests without skips and measured
61.98% statements, 55.66% branches, 62.56% functions and 64.50% lines. The
current floors above were raised after this run. After the cross-run search
changes, a further CI-mode run passed 2,334 tests without skips and measured
62.06% statements, 55.74% branches, 62.64% functions and 64.57% lines. A hosted
Linux CI result remains to be verified. The latest CI-mode run passed 2,497 tests
without skips and measured 62.56% statements, 56.24% branches, 63.07% functions
and 65.04% lines.

The latest isolated CI-mode run passed 2,562 tests without skips and measured
63.06% statements, 56.76% branches, 63.42% functions and 65.54% lines.

The floors leave modest headroom for measurement variation while preventing material regression. Raise a floor after a successful full-suite run when the improvement leaves reasonable headroom. Do not lower a floor merely to pass a failing check; investigate the missing coverage or changed source first. CI requires the external tools checked by `scripts/verify-test-tools.mjs`, including OpenSSL, qpdf and pdfsig.
