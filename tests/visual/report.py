"""Create A/B boards and a local review page from the browser comparison run.

Requires Pillow; on the development VM use the artifacts Python environment.
"""
import json
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'test-results' / 'ab'
font_path = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
font = ImageFont.truetype(font_path, 22) if Path(font_path).exists() else ImageFont.load_default()
results = []
for name in ['desktop', 'mobile', 'desktop-archive', 'mobile-archive']:
    a = Image.open(OUT / f'{name}-normalized-osu.png').convert('RGB')
    b = Image.open(OUT / f'{name}-normalized-uo.png').convert('RGB')
    assert a.size == b.size, f'{name}: screenshot sizes differ'
    difference = ImageChops.difference(a, b)
    pixels = list(difference.get_flattened_data())
    changed = sum(pixel != (0, 0, 0) for pixel in pixels)
    significant = sum(max(pixel) > 12 for pixel in pixels)
    results.append(dict(view=name, width=a.width, height=a.height,
        changedPixels=changed, changedPercent=round(changed / len(pixels) * 100, 6),
        maximumChannelDifference=max(max(pixel) for pixel in pixels),
        pixelsBeyondAntialiasTolerance=significant))
    difference.save(OUT / f'{name}-difference.png')
    assert significant == 0, f'{name}: visible pixel difference ({significant} pixels)'

for name in ['desktop-matched','mobile-matched','desktop-archive','mobile-archive','desktop-actual','mobile-actual','desktop-advanced','mobile-advanced']:
    a = Image.open(OUT / f'{name}-osu.png').convert('RGB')
    b = Image.open(OUT / f'{name}-uo.png').convert('RGB')
    gap, heading = 24, 52
    board = Image.new('RGB', (a.width + b.width + gap, max(a.height,b.height)+heading), '#101010')
    draw = ImageDraw.Draw(board)
    draw.text((14,13), 'A  OSU', font=font, fill='#ef774c')
    draw.text((a.width+gap+14,13), 'B  UO', font=font, fill='#FEE11A')
    board.paste(a,(0,heading)); board.paste(b,(a.width+gap,heading))
    board.save(OUT / f'{name}-ab.png')
(OUT/'pixel-summary.json').write_text(json.dumps(results,indent=2)+'\n')
geometry = json.loads((OUT/'geometry-summary.json').read_text())
assert all(not result['geometryErrors'] for result in geometry), 'Layout differences remain'

rows = ''.join(f"<tr><td>{r['view']}</td><td>{r['width']} × {r['height']}</td><td>0</td><td>{r['changedPixels']:,}</td><td>{r['changedPercent']}%</td></tr>" for r in results)
html = '''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OSU / UO visual A/B comparison</title>
<style>body{background:#181818;color:#eee;font:15px/1.5 system-ui;margin:30px auto;padding:0 20px;max-width:1400px}h1{font-size:25px}p{max-width:1050px;color:#bbb}a{color:#fee11a}nav{display:flex;gap:10px;flex-wrap:wrap;margin:24px 0}button{padding:10px 16px;border:1px solid #555;border-radius:7px;background:#292929;color:#ddd;cursor:pointer}button[aria-pressed=true]{border-color:#fee11a;color:#fee11a}img{display:block;width:100%;height:auto;border:1px solid #444}table{border-collapse:collapse;margin:22px 0}th,td{padding:10px 16px;text-align:left;border:1px solid #444}th{color:#ccc}label{display:block;margin:20px 0}input{width:300px}.overlay{position:relative;width:min(100%,900px);margin-top:20px}.overlay>img{width:100%}.overlay .top{position:absolute;inset:0;overflow:hidden;clip-path:inset(0 50% 0 0)}.overlay .top img{width:100%}[hidden]{display:none!important}.badge{color:#8abb40}</style>
<h1>OSU / UO — visual A/B comparison</h1>
<p class="badge">Shared OSU stylesheet: byte-identical. Dashboard and archive geometry: no differences at either viewport.</p>
<p>The matched views run the real OSU and UO applications using equivalent synthetic records. Institution-specific headings, explanatory copy, and source-action labels are normalized for comparison. The colored A/B boards retain each institution’s palette. The original sites remain available under “Actual sites”; UO still has no imported salary data.</p>
<p>The pixel test then disables only UO’s color override and restores OSU’s chart colors. It compares screenshot RGB values without resizing or masking. Mobile archive edge pixels may show minute browser antialiasing differences; both the raw count and the 12-channel-level tolerance check are recorded below. Advanced filters retain source-specific labels and controls and are shown for visual inspection, not included in the zero-difference assertion. The original OSU mobile Advanced panel’s horizontal overflow is preserved by the shared stylesheet.</p>
<p>UO’s palette comes from <a href="https://communications.uoregon.edu/uo-brand/visual-identity/colors">University Communications</a>: Green #007030, Yellow #FEE11A, with Moss #8ABB40 for readable salary text. Neutral surfaces, type, sizes, spacing, and breakpoints come directly from OSU.</p>
<table><thead><tr><th>View</th><th>Viewport</th><th>Geometry differences</th><th>Raw differing pixels</th><th>Pixel difference</th></tr></thead><tbody>ROWS</tbody></table>
<nav aria-label="Comparison view"><button data-view="matched" aria-pressed="true">Matched dashboard</button><button data-view="archive" aria-pressed="false">Matched archive</button><button data-view="actual" aria-pressed="false">Actual sites</button><button data-view="advanced" aria-pressed="false">Advanced controls</button></nav>
<nav aria-label="Viewport"><button data-size="desktop" aria-pressed="true">Desktop · 1440 px</button><button data-size="mobile" aria-pressed="false">Mobile · 390 px</button></nav>
<img id="board" src="desktop-matched-ab.png" alt="OSU on the left and UO on the right, showing matched layout with institution colors">
<details><summary>Overlay the matched dashboard</summary><label>Reveal OSU over UO <input id="reveal" type="range" min="0" max="100" value="50"></label><div class="overlay"><img id="under" src="desktop-matched-uo.png" alt="UO matched dashboard"><div id="over" class="top"><img id="over-image" src="desktop-matched-osu.png" alt="OSU matched dashboard"></div></div></details>
<p><a href="geometry-summary.json">Geometry results</a> · <a href="pixel-summary.json">Pixel results</a></p>
<script>let view='matched',size='desktop';function update(){document.getElementById('board').src=`${size}-${view}-ab.png`;document.getElementById('under').src=`${size}-matched-uo.png`;document.getElementById('over-image').src=`${size}-matched-osu.png`;document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));document.querySelectorAll('[data-size]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.size===size)))}document.querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{view=b.dataset.view;update()});document.querySelectorAll('[data-size]').forEach(b=>b.onclick=()=>{size=b.dataset.size;update()});document.getElementById('reveal').oninput=e=>document.getElementById('over').style.clipPath=`inset(0 ${100-e.target.value}% 0 0)`;</script></html>'''.replace('ROWS',rows)
(OUT/'index.html').write_text(html)
print(json.dumps(results,indent=2))
