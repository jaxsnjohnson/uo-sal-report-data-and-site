# Direct OSU/UO comparison

`tests/visual/compare.cjs` serves both actual checkouts and supplies identical
OSU-format data to their ordinary loaders. It normalizes only the institution
heading and source-notice text (explicitly permitted differences). It does not
replace components, inject a substitute renderer, or change styles.

```sh
node tests/visual/compare.cjs
```

At desktop (1440 px) and mobile (390 px), all 14 measured component rectangles
match within one pixel: title row, dashboard, statistic values, tenure chart,
role donut, organization leaderboard, history header, search, Advanced button,
search-help panel, result count, card, and card header. Screenshots and full
measurements are written to `test-results/parity/`.

The normal browser suite separately runs against the full UO dataset in Chromium,
Firefox, and WebKit. This verifies the real normalization and all chart panels,
rather than relying on the comparison fixture to establish data correctness.

Differences intentionally retained: UO colors and links; the source update in place
of OSU's FOIA notice; source-specific methodology; an Advanced actual-pay selector;
missing tenure data; and small mobile control fixes for the new UO labels. The
original OSU components and layout remain the basis of the application.
