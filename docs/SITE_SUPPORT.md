# Site integration status

Date: 2026-09-12, 05:27–05:29 UTC. Tested on this Windows host with yt-dlp 2026.08.19, standalone Node 22.23.2, and FFmpeg/ffprobe 9.0.1. Status follows observed files and complete decoding, not extractor listings.

| Provider | Public fixture from official yt-dlp tests | Observed live result |
|---|---|---|
| YouTube | [x41yOUIvK2k](https://www.youtube.com/watch?v=x41yOUIvK2k), listed in [YouTube extractor tests](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/youtube/_video.py) | **Passed** inspection, download, probe, and full decode. H.264/AAC in Matroska, 1920×1080, 6.85 s, 3,795,928 bytes. |
| X/Twitter | [CaptainAmerica post 719944021058060289](https://twitter.com/captainamerica/status/719944021058060289), listed in [Twitter extractor tests](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/twitter.py) | **Passed** inspection, download, probe, and full decode. H.264/AAC MP4, 1280×720, 3.178667 s, 539,283 bytes. |
| Reddit | [r/aww post 90bu6w](https://www.reddit.com/r/aww/comments/90bu6w/heat_index_was_110_degrees_so_we_offered_him_a/), listed in [Reddit extractor tests](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/reddit.py) | **Passed** inspection, download, probe, and full decode. H.264 MP4 with no audio stream, 608×1080, 13.7 s, 14,613,430 bytes. |

Each provider was run separately with its public URL in `MW_LIVE_YOUTUBE_URL`, `MW_LIVE_X_URL`, or `MW_LIVE_REDDIT_URL`, followed by `npx tsx --test tests/live-sites.test.ts`. No browser profile, account cookies, or personal credentials were supplied. Public source definitions were read before selecting fixtures. These are actual site extractor and network requests through the application's filtering proxy. Deterministic Generic-extractor and nested-HLS isolation tests remain separate.

Evidence is retained in `test-output/live-sites/youtube-UWaTef`, `x-8KFDt9`, and `reddit-IYqsjG`: each contains `support-status.json`, the downloaded file, and an extracted `frame.png` at one second. All three frames were visually inspected: horse-riding footage, a seated interview subject, and a frog beside an offered drink, respectively. Reports record exact versions, timestamps, file sizes, stream metadata, and inspection entry counts.

The first YouTube attempt used the older `BaW_jenozKc` fixture and failed during inspection with “This video is unavailable.” That failure is retained under `test-output/live-sites/youtube-arXHrm/support-status.json`; no completed media was produced. It establishes that this fixture was unavailable to this test, not that every YouTube download fails. Selecting the currently listed short public `x41yOUIvK2k` fixture then passed the complete workflow. The tool also warned that `--no-call-home` is deprecated; it did not prevent successful downloads.

These results verify the chosen public posts on this host and date. They do not certify every post, live multi-video site behavior, authenticated content, regional access, or future extractor changes. Live tests remain opt-in to avoid routine external traffic. An unavailable or restricted post should report its real error; it must never be presented as a successful download or bypassed using a host owner's credentials.

Netscape cookies files and explicit browser-profile selection are implemented only for the local owner. Synthetic-file encryption/lifecycle is tested on Windows and Linux. Actual browser extraction and authenticated site workflows remain untested. The app never instructs users to disable browser protections or silently relay cookies to shared servers.
