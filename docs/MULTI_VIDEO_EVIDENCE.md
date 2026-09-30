# Multi-video post selection

Verified on Windows on 2026-09-12 using the tool versions recorded in `test-output/multi-video-PKfguS/evidence.json`.

`DownloadSchema` accepts an optional integer `itemIndex` from 1 through 100. Omitting it selects the first item. `apps/server/src/download.ts` keeps yt-dlp's `--no-playlist` behavior for a URL that includes both a video and playlist context, while inspecting at most the first 100 collection entries with `--playlist-items 1:100 --lazy-playlist`. Downloads select exactly one index. A requested nondefault index is checked before download; a direct-video URL cannot silently ignore item 2 and produce item 1. These switches follow the [official yt-dlp options](https://github.com/yt-dlp/yt-dlp#video-selection).

The web input screen lists the returned entries and binds its format table to the selected entry. Changing the URL, authentication, or selected entry clears stale selection data. Quick downloads and batches retain the first-item default. A completed inspection of an older URL cannot overwrite a newer selection.

`npx tsx --test tests/multi-video.test.ts` passed against real yt-dlp's Generic extractor and an explicit local HTTP fixture:

- A post containing red and blue video elements exposed both entries and format choices.
- The first-item default downloaded only the red video; item 2 downloaded only the blue video. Both outputs were byte-identical to their respective inputs and fully decoded with FFmpeg. The selected blue output is 192×108; its extracted `second-frame.png` was visually inspected.
- A 105-entry fixture exposed exactly 100 entries with a visible inspection limit.
- Missing item 3, item 2 on a direct-video URL, fractional indices, and values outside 1–100 were rejected. No completed file appeared for missing selections.
- A direct media URL with an incidental playlist query still produced one file.

The expanded `npm run test:ui` also passed 19 observations. In real Edge it inspected a two-video post, selected item 2, queued the real job, and compared the completed artifact bytes with the second input. It then exercised the editor/export workflow. `test-output/browser/multi-video-selection.png` was visually inspected; `test-output/browser/evidence.json` records the run.

This deterministic provider-boundary proof does not establish every live site's multi-video extractor behavior. Live YouTube, X/Twitter, and Reddit status remains separately reported. Inspection intentionally stops at 100 entries and does not offer whole-playlist downloading.
