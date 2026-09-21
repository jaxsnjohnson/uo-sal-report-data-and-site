# OSU / UO visual comparison

The UO redesign now uses OSU's original component structure and base CSS.
`css/styles.css` is byte-identical to the OSU checkout used for the comparison.
`css/uo-theme.css` overrides only colors. The prior UO navigation bar, hero,
four-card dashboard, always-visible filters, and footer are removed.

## Reference and method

- Reference: `jaxsnjohnson/osu-sal-report-data-and-site`, commit `776803d`.
- File checksums: `tests/visual/reference.json`; a changed reference fails the test.
- Browser: the same Chromium build for both sites.
- Viewports: 1440 × 1300 desktop and 390 × 1800 mobile, device scale 1.
- Both real applications generate their own DOM from equivalent synthetic salary
  observations. The archive uses the same UO report catalog in each site's format.
- Headings, explanatory copy, source labels and record-count text are normalized
  to isolate layout. Salary records never enter the real UO dataset.
- Colored A/B screenshots keep the different institution palettes. The pixel
  pass disables UO's color-only stylesheet and maps the donut palette to OSU's.
- No images are resized or masked before the numeric comparison.

## Results

| View | Geometry differences | Raw differing screenshot pixels |
| --- | ---: | ---: |
| Desktop dashboard | 0 | 0 |
| Mobile dashboard | 0 | 0 |
| Desktop archive | 0 | 0 |
| Mobile archive | 0 | 102 of 702,000 (0.01453%) |

The mobile archive residual is limited to text/border antialiasing: at most
9/255 in any RGB channel. No pixels differ beyond the explicitly reported
12/255 antialiasing tolerance. Raw counts are retained, rather than described as
zero. Measured geometry includes positions, dimensions, and, for the dashboard,
typography, spacing, and radii.

These results cover the matched dashboard and archive viewport captures. They
do not assert identical university data or identical content in every expanded
state. Advanced panels retain UO-specific report/pay controls in OSU's component
slots; colored screenshots of both panels are provided for review. The original
OSU mobile Advanced panel's horizontal overflow is inherited unchanged.

## Artifacts and rerunning

Run from the repository root, with both localhost previews available:

```sh
NODE_PATH=/home/codex/tools/browser-tests/node_modules node tests/visual/compare.cjs
/home/codex/tools/artifacts/bin/python tests/visual/report.py
```

The first command uses the installed Playwright runtime. The second requires
Pillow; the documented artifacts interpreter supplies it on this host.

Generated artifacts live in `test-results/ab/`:

- `index.html`: review page with A/B view controls and a reveal slider.
- `desktop-matched-ab.png`, `mobile-matched-ab.png`: dashboard A/B boards.
- `desktop-archive-ab.png`, `mobile-archive-ab.png`: archive A/B boards.
- `*-actual-*.png`: each site's actual current state, including UO's pending data.
- `*-advanced-*.png`: expanded controls with source-specific labels.
- `*-normalized-*.png`, `*-difference.png`: inputs to the pixel comparison and diffs.
- `geometry-summary.json`, `pixel-summary.json`: numeric results.

The screenshot artifacts are ignored by Git; the repeatable test and this
verification record are part of the repository.
