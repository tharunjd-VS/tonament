# Writing a blog post

Posts live in `content/blog/`, one Markdown file each. The file name is the address:
`content/blog/how-we-run-our-club-night.md` is `tonament.com/blog/how-we-run-our-club-night`.
Use lower-case words joined by hyphens. Add the file, push to main, and the post is live
(it also appears in `/blog`, the RSS feed at `/blog/rss.xml` and the sitemap).

## Front matter

Every post starts with this block:

```
---
title: How we run our club night in 90 minutes
description: One or two sentences, 150–160 characters. This is what Google and WhatsApp show.
date: 2026-11-05
author: Tonament
tags: [organisers, badminton]
image: /blog/club-night.jpg
featured: false
---
```

- **title**, **description**, **date** (YYYY-MM-DD) are required. A post with a missing or bad one fails `npm test`, naming the file.
- **tags**: a few topics, lower-case. A tag that is a sport id (`badminton`, `pickleball`, `table-tennis`…) also lists the post on that sport's page. Each tag gets a page at `/blog/tag/<tag>`.
- **image** (optional): the picture for link previews, 1200 × 630, put in `public/blog/`. Without one, the features preview image is used.
- **featured** (optional): `true` pins the post at the top of `/blog`. Keep it to one post.
- **updated** (optional): YYYY-MM-DD when you change a post substantially.

## What you can write

- `## Heading` and `### Smaller heading` (the title is the page's only top-level heading; four or more `##` headings get an "In this post" list).
- Paragraphs, `**bold**`, `*italic*`, `` `code` ``, and links `[text](/tools)`. Links to other sites open in a new tab.
- Lists with `-` or `1.`, quotes with `>`, a line `---` for a divider.
- Tables:
  ```
  | Format | Matches |
  |---|---|
  | Knockout | 15 |
  ```
- Images on their own line: `![What the picture shows](/blog/photo.jpg "Optional caption")`.
  App screenshots from `public/guide/` with `{theme}` in the name show the dark or light version to match the reader:
  `![Groups split by level](/guide/pools-{theme}.jpg "Each level plays its own groups.")`
- A handwritten fixture sheet, like the home page's:
  ```
  :::paper What the sheet shows (for screen readers)
  OPEN — Men's Doubles ₹600
  INT: Mohan ✓ ~~Om/Prakash~~ ==→ Ravi==
  ((SF: BEG v INT))
  :::
  ```
  `~~text~~` is crossed out, `==text==` is red ink, `((text))` is circled.
- Two columns side by side (they stack on phones), split by a line of `---`:
  ```
  :::compare
  **On paper today**

  Names in a notebook…
  ---
  **With Tonament**

  One link…
  :::
  ```

HTML in a post is shown as text, not run.

## House style

Follow `docs/BRAND.md`: plain words, short sentences, Indian English (organiser, colour, ₹). Write for the organiser
at the desk on the day. Every post should end with somewhere to go next — a tool, another post or "Create your tournament"
(`/signup?next=%2Fnew`). Check that anything you say Tonament does, it does today.
