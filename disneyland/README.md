# Disney World Family HQ

A family trip planner for a 2027 or 2028 Walt Disney World trip for 15 people. Plain HTML, CSS and JavaScript: no build tools, no server, no accounts.

The folder is still called `disneyland` because the plan started there; the content is all Walt Disney World. The destination lives entirely in `guide.js`, so the app itself does not care which resort it describes.

## What is in here

| File | What it is |
|---|---|
| `guide.js` | The research: best times to go, prices, booking windows, hotels, rides and heights, packing lists, plus the trivia, movie-night and daily-magic content. Edit this when facts change. |
| `plan.json` | The family's shared plan: trip dates, crew, shortlist, bookings, itinerary, updates. |
| `app.js` | The app: pages, forms, the night-sky hero and fireworks, the live countdown, the budget estimator, the who-can-ride chart, the Fun zone games, saving. |
| `styles.css` | The look, in light and dark. |
| `shell.js` | The page's HTML shell, used by both the build and the in-page Save. |
| `build.mjs` | Rebuilds `page.html` and `index.html` from `shell.js` and `plan.json`. |
| `page.html` | The page as published to Claude (built). |
| `index.html` | The same page as a complete document for any static host (built). |

## Two ways to run it

**As a Claude page (the live family copy).** The published page lets organizers edit the plan in place and press **Save for everyone**. Each save stores a new version of the page with the plan inside it, so everyone who opens the link sees the same plan.

**As a plain website.** Serve this folder from GitHub Pages, Vercel, Netlify or any static host and open `index.html`. Visitors see the plan from `plan.json`. Edits made there stay on that device; use **Copy plan data** to export them, paste the result into `plan.json`, then rebuild.

## Updating

```bash
# after changing plan.json or shell.js
node build.mjs

# preview locally
python3 -m http.server 8000   # then open http://localhost:8000
```

`guide.js`, `app.js` and `styles.css` are loaded directly, so changes to them need no build.

## Who sees what

- **Shared plan** (dates, crew, shortlist, bookings, itinerary, updates): saved by organizers, seen by everyone with the link.
- **Personal** (budget numbers, savings log, packing ticks, ride stars): kept in that person's browser only.

The page is readable by anyone who has the link, so keep full confirmation numbers, room numbers and phone numbers out of it.

## Keeping the research fresh

`guide.js` records when it was last checked (`asOf`). Disney World puts each new year on sale in spring (and November and December in early October), usually at higher prices, and announces seasonal dates a few months ahead. Re-check prices and dates before paying for anything.

Unofficial planner. Not affiliated with or endorsed by The Walt Disney Company.
