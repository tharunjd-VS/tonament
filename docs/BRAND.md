# Tonament brand guidelines

**One platform. Every sport. Every tournament.**

The logo was recreated as SVG from the brand board. To use the designer's original files, replace the SVGs in `public/brand/` (keep the same file names) and run `node scripts/brand/render.js` to rebuild the PNGs.

## Logo

| File | Use |
|---|---|
| `public/brand/logo-white.svg` | Primary lockup on Deep Navy: site header, hero, dark surfaces |
| `public/brand/logo.svg` | Primary lockup on light backgrounds |
| `public/brand/logo-stacked(-white).svg` | Mark above wordmark, for square or centred layouts |
| `public/brand/mark(-white).svg` | The T mark alone: footer, small spaces |
| `public/brand/wordmark(-white).svg` | TONAMENT alone, when the mark is already nearby |
| `public/brand/icon.svg`, `icon-*.png`, `apple-touch-icon.png`, `/favicon.ico` | App icon: navy rounded square, white T, lime dot |
| `public/brand/email-logo.png` | White lockup as a PNG for emails (mail apps don't show SVG) |
| `public/brand/og.png` | 1200×630 link preview |

Rules:
- **The dot is always Electric Lime.** Only the T and the wordmark switch between navy and white.
- **Clear space:** keep at least the dot's diameter of empty space on every side.
- **Minimum size:** mark 24 px tall; horizontal lockup 18 px tall.
- **Don't** stretch, rotate, outline or add effects; don't put the logo on photos without a navy overlay; don't set the wordmark in another font.

## Colour

| Token | Hex | Role |
|---|---|---|
| Deep Navy | `#0B1220` | Primary. Default page background, header, scoreboard, text on light |
| Electric Lime | `#A3E635` | Accent. Primary buttons, active states, live data, highlights |
| Slate | `#475569` | Secondary. Second player/team, secondary fills, muted text on light |
| Mist | `#E5E7EB` | Neutral. Text on navy, light-theme background |

Supporting UI shades live in `public/styles.css` (`:root` and `:root[data-theme='light']`). Use the CSS variables (`--accent`, `--accent-text`, `--on-accent`, `--surface`, `--muted`, …), never raw hex values in components.

### Contrast rules (WCAG AA)
- **Lime is a fill, not a text colour on light backgrounds.** Lime on white is 1.5:1, which is unreadable. On light surfaces use `--accent-text` (`#3F6212`, 7:1).
- On lime, always use **navy text** (12.4:1). Never white on lime.
- Lime text is fine on navy (12.4:1): headlines, the winner's name, "Every tournament."
- Red is reserved for **LIVE** and errors. Don't use it for decoration.
- Side A (first player) = lime fill + navy text; side B = slate fill + light text. The two scoring buttons must always look clearly different.

## Typography
- **Outfit**, self-hosted at `public/fonts/Outfit-Variable.woff2` (SIL Open Font License, see `Outfit-OFL.txt`).
- Headings 700 · buttons/labels 600 · body 400. Score numbers 700 with tabular figures.
- Eyebrows/taglines: uppercase, letter-spacing 0.2–0.3 em, weight 500–600, e.g. `ONE PLATFORM. EVERY SPORT. EVERY TOURNAMENT.`, with the last line in lime when on navy.

## Themes
- **Dark (Deep Navy) is the default**, as in the brand mockups. A light (Mist) theme is used when the device prefers light, or when the person chooses it.
- The header, hero, scoreboard and champion banner stay navy in both themes.
- The choice is stored in `localStorage` (`tonament:theme` = `auto | dark | light`) and applied before first paint by the snippet in `index.html`.

## Imagery
- Brand imagery: athletes in **monochrome**, with **lime diagonal slashes** (about 25°). In the app the slashes are pure CSS (see `.hero` in `styles.css`).
- Photos must be licensed. The hero has a `--hero-image` CSS variable ready for one; put a navy overlay behind any text.

## Voice
- Short, direct, sporty. "Run your tournament. Score it live."
- The name is written **Tonament** in sentences; the logo shows it in capitals.

## Emails
`server/email.js` `layout()`: Mist page, white card, navy header band with `email-logo.png` and a 4 px lime underline, lime button with navy text, and the tagline in the footer.
