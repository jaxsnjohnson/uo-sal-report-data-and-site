# Attribution

This site directly copies the HTML, CSS, JavaScript, charts, search worker, and
static artifact builder from Jax SN Johnson's OSU Salary Transparency project:
https://github.com/jaxsnjohnson/osu-sal-report-data-and-site

The UO copy retains the GPL-3.0 license in LICENSE. Its differences are UO branding,
source-specific normalization, accurately labeled UO data limitations, and the
replacement of the OSU records-request notice. Original UO PDFs and source
metadata are retained without alteration. See docs/osu-copy.json for the source
revision and file checksums.

Chart.js 4.5.1 is bundled from https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.js
(the version served by OSU's CDN dependency when copied). Its MIT license is
preserved in `js/vendor/Chart.js-LICENSE.md`. The UO page can render charts without
contacting a third-party script host. No analytics provider is configured.
