# Kandelbrot

A recursive, "fractal" kanban: at every level a card lives in a **To-do / Doing / Done**
column, and zooming into a card reveals its children as their own To-do/Doing/Done
board — all the way down. *Kanban + Mandelbrot.*

It renders on a single `<canvas>` with a hand-written camera, level-of-detail
culling, and [Pretext](https://github.com/chenglou/pretext) for text layout — no
DOM node per card, so the continuous zoom stays smooth at any depth.

## Status

Built in deliberate, riskiest-first steps:

- [x] **1 — Camera.** Infinite pan + zoom-toward-cursor over a world of placeholder
  boxes, with off-screen culling. *(the make-or-break interaction)*
- [ ] 2 — Recursive level-of-detail render of a nested tree
- [ ] 3 — Text via Pretext
- [ ] 4 — Click to fly into a card + breadcrumb
- [ ] 5 — Data model, hybrid (derived + pinned) status, localStorage
- [ ] 6 — Inline editing (DOM overlay), add / delete
- [ ] 7 — Status toggle, then drag-and-drop

## Run

```bash
npm install
npm run dev
```

Open the printed URL, then **drag** to pan and **scroll / pinch** to zoom.
