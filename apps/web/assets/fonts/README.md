# Title font

Playfair Display is distributed under the SIL Open Font License 1.1 in the adjacent license file.

Source: https://github.com/google/fonts/tree/main/ofl/playfairdisplay

`PlayfairDisplay.ttf` is the upstream variable font. `PlayfairDisplay-Bold.ttf` is a static instance at weight 700, produced with fontTools.varLib.instancer. Both the browser title overlay and FFmpeg title export use the static instance so the selected family has consistent weight. No network font request is needed at runtime. `scripts/build.mjs` copies the files and license into `dist/web/fonts`.
