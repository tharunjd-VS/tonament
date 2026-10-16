# Generates the Tonament logo SVGs (recreated from the brand board).
# Usage: python3 scripts/brand/generate_logos.py && node scripts/brand/render.js
# To use the designer's original files instead, replace the SVGs in
# public/brand/ (same names) and run only render.js.
import math, os, sys
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', 'public', 'brand')
NAVY, LIME, WHITE = '#0B1220', '#A3E635', '#FFFFFF'

# ---- mark: lime dot over a T with a tapered crossbar (100 wide, 72 tall)
MARK_W, MARK_H = 100, 72
def mark(color, dx=0, dy=0, scale=1):
    f = lambda x, y: f'{dx + x*scale:.2f} {dy + y*scale:.2f}'
    t = f'M{f(0,26)} L{f(100,26)} L{f(84,38)} L{f(59.5,38)} L{f(59.5,72)} L{f(40.5,72)} L{f(40.5,38)} L{f(16,38)} Z'
    return (f'<circle cx="{dx+50*scale:.2f}" cy="{dy+10*scale:.2f}" r="{10*scale:.2f}" fill="{LIME}"/>'
            f'<path d="{t}" fill="{color}"/>')

# ---- wordmark: wide geometric capitals built from polygons (cap height 40, stroke 8)
H, S, GAP = 40.0, 10.5, 6.5
def poly(pts):
    # normalise to clockwise so overlapping parts union under nonzero fill
    a = sum(x1*y2 - x2*y1 for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]))
    if a < 0: pts = pts[::-1]
    return 'M' + ' L'.join(f'{x:.2f} {y:.2f}' for x, y in pts) + ' Z'
def rect(x, y, w, h): return poly([(x, y), (x + w, y), (x + w, y + h), (x, y + h)])
def para(top_l, top_r, bot_r, bot_l): return poly([top_l, top_r, bot_r, bot_l])

def letter(ch, x):
    if ch == 'T':
        w = 48; return [rect(x, 0, w, S), rect(x + w/2 - S/2, 0, S, H)], w, None
    if ch == 'O':
        w = 58; r = (H - S) / 2
        o = (f'<rect x="{x + S/2:.2f}" y="{S/2:.2f}" width="{w - S:.2f}" height="{H - S:.2f}" rx="{r:.2f}" '
             f'fill="none" stroke-width="{S:.2f}"/>')
        return [], w, o
    if ch == 'N':
        w = 50; d = S * math.hypot(w - S, H) / H
        return [rect(x, 0, S, H), rect(x + w - S, 0, S, H),
                para((x, 0), (x + d, 0), (x + w, H), (x + w - d, H))], w, None
    if ch == 'A':
        w = 56; d = S * math.hypot(w / 2, H) / H; cx = x + w / 2
        return [para((cx - d/2, 0), (cx + d/2, 0), (x + d, H), (x, H)),
                para((cx - d/2, 0), (cx + d/2, 0), (x + w, H), (x + w - d, H)),
                rect(x + w*0.24, H*0.62, w*0.52, S*0.85)], w, None
    if ch == 'M':
        w = 62; cx = x + w / 2; d = S * math.hypot(w / 2, H) / H
        return [rect(x, 0, S, H), rect(x + w - S, 0, S, H),
                para((x, 0), (x + d, 0), (cx + d/2, H), (cx - d/2, H)),
                para((x + w - d, 0), (x + w, 0), (cx + d/2, H), (cx - d/2, H))], w, None
    if ch == 'E':
        w = 42; return [rect(x, 0, S, H), rect(x, 0, w, S), rect(x, H/2 - S/2, w*0.86, S), rect(x, H - S, w, S)], w, None
    raise ValueError(ch)

def wordmark(color, text='TONAMENT', dx=0, dy=0, scale=1):
    paths, extras, x = [], [], 0.0
    for ch in text:
        p, w, extra = letter(ch, x)
        paths += p
        if extra: extras.append(extra)
        x += w + GAP
    width = x - GAP
    g = (f'<g transform="translate({dx:.2f} {dy:.2f}) scale({scale})" fill="{color}" stroke="{color}">'
         f'<path stroke="none" d="{" ".join(paths)}"/>{"".join(extras)}</g>')
    return g, width

def svg(w, h, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}" width="{w:.0f}" height="{h:.0f}" '
            f'role="img" aria-label="{title}"><title>{title}</title>{body}</svg>\n')

os.makedirs(OUT, exist_ok=True)
_, WM_W = wordmark(NAVY)
for name, color in (('', NAVY), ('-white', WHITE)):
    open(f'{OUT}/mark{name}.svg', 'w').write(svg(MARK_W, MARK_H, mark(color), 'Tonament'))
    g, _ = wordmark(color)
    open(f'{OUT}/wordmark{name}.svg', 'w').write(svg(WM_W, H, g, 'Tonament'))
    # horizontal lockup: mark height 72 -> wordmark cap height 40, vertically centred on the T
    gap = 22
    g, _ = wordmark(color, dx=MARK_W + gap, dy=22)
    open(f'{OUT}/logo{name}.svg', 'w').write(svg(MARK_W + gap + WM_W, MARK_H, mark(color) + g, 'Tonament'))
    # stacked lockup: mark centred above the wordmark
    sw = WM_W; mx = (sw - MARK_W*1.4) / 2
    g, _ = wordmark(color, dy=MARK_H*1.4 + 26)
    open(f'{OUT}/logo-stacked{name}.svg', 'w').write(svg(sw, MARK_H*1.4 + 26 + H, mark(color, dx=mx, scale=1.4) + g, 'Tonament'))

# app icon: navy rounded square, white T, lime dot (mark ~58% of the width)
ICON = 512; ms = ICON*0.62/MARK_W
icon = (f'<rect width="{ICON}" height="{ICON}" rx="{ICON*0.22:.0f}" fill="{NAVY}"/>'
        + mark(WHITE, dx=(ICON - MARK_W*ms)/2, dy=(ICON - MARK_H*ms)/2 - ICON*0.02, scale=ms))
open(f'{OUT}/icon.svg', 'w').write(svg(ICON, ICON, icon, 'Tonament'))
# maskable / full-bleed variant for Android (no rounded corners, safe-zone padding)
ms2 = ICON*0.46/MARK_W
icon2 = f'<rect width="{ICON}" height="{ICON}" fill="{NAVY}"/>' + mark(WHITE, dx=(ICON - MARK_W*ms2)/2, dy=(ICON - MARK_H*ms2)/2, scale=ms2)
open(f'{OUT}/icon-maskable.svg', 'w').write(svg(ICON, ICON, icon2, 'Tonament'))
# favicon: same icon with the mark as large as it can go, for 16-32 px tabs
ms3 = ICON*0.80/MARK_W
fav = (f'<rect width="{ICON}" height="{ICON}" rx="{ICON*0.2:.0f}" fill="{NAVY}"/>'
       + mark(WHITE, dx=(ICON - MARK_W*ms3)/2, dy=(ICON - MARK_H*ms3)/2, scale=ms3))
open(f'{OUT}/favicon.svg', 'w').write(svg(ICON, ICON, fav, 'Tonament'))
print('wordmark width', round(WM_W, 1))
