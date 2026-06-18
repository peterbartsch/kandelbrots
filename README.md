# Kandelbrot

A recursive, "fractal" kanban: every card lives in a **To-do / Doing / Done** board,
and zooming into it reveals its children as their own board — all the way down.
*Kanban + Mandelbrot.* Live at [kandelbrot.com](https://kandelbrot.com).

## What it is

- **Infinite spatial canvas** — pan, pinch-zoom, and scroll-to-zoom over a world of nested boards rendered on a single `<canvas>`. No DOM node per card; custom camera with off-screen culling keeps it smooth at any depth.
- **Fractal hierarchy** — cards nest arbitrarily deep. Status at every level is either set explicitly (pinned) or derived from children (a parent is Done only when all its leaves are Done).
- **Three-pane desktop layout** — 280 px nav rail (search + board tree + toolbar + theme) · canvas · 320 px inspector (breadcrumb, % done bar, task list, leaf status setter).
- **Mobile** — full-screen canvas with slide-in Board / Focus drawers toggled by corner buttons; scrim-to-dismiss.
- **Depth-aware inspector** — breadcrumb path, leaf-weighted progress bar, per-task completion counts, status buttons only appear at the leaf level where they apply.
- **Tree search** — filters the board tree in the nav rail; matched paths stay expanded, non-matching branches collapse.
- **Hover sync** — hovering a row in the tree draws a dashed accent ring on the corresponding card in the canvas.
- **Inline rename** — click a card title in the inspector or double-click it in the canvas to edit in place.
- **Long-press to arrange** — touch (480 ms hold) or keyboard Tab toggles Navigate ↔ Arrange mode.
- **Double-click to fly** — double-click any card to animate the camera to fill the viewport with it.
- **Light / Dark themes** — Solarized Light (default) and Atlas (a cool near-black palette matched to the [Atlasphere](https://atlasphere.io) living-map UI).
- **Import / Export** — Markdown export of the full tree; Markdown import seeds a new board.
- **Persistent storage** — board saved to `localStorage`; ships with a 6-level, 418-node fractal demo board.

## Run locally

```bash
npm install
npm run dev
```

**Drag** to pan, **scroll / pinch** to zoom, **double-click** to fly into a card.

## Deploy

Builds with Vite and ships to Dreamhost via a single SSH tarball stream (faster than rsync over DH's link):

```bash
./deploy.sh
```

Requires an SSH alias `dreamhost` pointing at `tronicadmin@petebartsch.com`.

## Tech

- TypeScript + Vite (no framework)
- Hand-written canvas renderer with camera, level-of-detail culling, and hit-testing
- CSS custom-property theme system
- Zero runtime dependencies
