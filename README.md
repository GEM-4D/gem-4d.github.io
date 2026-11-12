# GEM-4D project page

Source for <https://gem-4d.github.io/> — the project page for *GEM-4D:
Geometry-Enhanced Video World Models for Robot Manipulation*
([arXiv:2605.22882](https://arxiv.org/abs/2605.22882)).

Static site, no build step. Everything it needs is in this repository.

## Running it locally

The page is an ES module and fetches JSON and textures, so it has to be served
over HTTP — opening `index.html` from disk will not work (the page says so if you
try).

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

If the browser reports *"Failed to fetch dynamically imported module"*, the
server is single-threaded and stalling on the parallel module requests; use any
threaded server instead (`npx serve`, `python3 -m http.server --bind 127.0.0.1`
under a threading handler, etc.).

## Layout

```
index.html                  the whole page: markup + the three viewers' logic
assets/css/site.css         design system and all component styles
assets/js/site.js           navigation, scroll-spy, reveal, BibTeX copy
assets/js/pointcloud-viewer.js
                            WebGL point-cloud player (see below)
assets/vendor/              three.js r180 + OrbitControls, self-hosted
assets/fonts/               Manrope + IBM Plex Mono, self-hosted
assets/media/trash/         hero rollout
assets/media/sim8/          side-by-side comparison, 8 cases x {gt, gem4d, tesseract}
assets/media/real/          deployment pipeline, 3 real-robot cases
assets/media/overview/      narrated project video, poster, English captions
Overview/                   paper figures
```

## How the point clouds are shipped

No point cloud is downloaded. Each clip ships as two atlas textures — a depth
atlas with 16-bit depth packed into the R and G bytes, and an RGB atlas — plus a
`meta.json` holding the capture intrinsics. The vertex shader back-projects them
on the GPU, so advancing a frame costs one uniform and a whole rollout costs a
couple of megabytes instead of a hundred.

`meta.json` fields worth knowing:

| field | meaning |
|---|---|
| `frames`, `cols`, `rows` | atlas layout |
| `fx`, `fy`, `cx`, `cy` | intrinsics the depth was produced with |
| `depthMin`, `depthMax` | de-quantisation range; `0` in the atlas means "no data" |
| `masked` | whether `0` should be treated as a hole |
| `centre` | orbit centre, on the optical axis |
| `fitAspects`, `fitDistances` | camera distance that keeps the cloud in frame across the sweep, per aspect ratio |
| `fps` | playback rate for this panel, chosen so every panel in a row ends together |

## Notes

Viewers can drop the point count from the caption bar if their machine struggles;
the choice is remembered. `KNOWN_ISSUES.md` records a driver bug that makes the
page look broken on one particular graphics stack, and how to work around it.

## Overview video

The project overview appears before the abstract. Its 92.5-second H.264/AAC video
uses native playback controls, English narration, burned-in English subtitles,
and an optional English caption track. It does not autoplay. The explicit
`gem4d-overview-en.mp4` is used by the website and English materials; the
`gem4d-overview-zh.mp4` retains Chinese subtitles for Chinese articles and their
clickable Word previews. The legacy `gem4d-overview.mp4` also serves the English
version.

## Playback trim

The hero rollout and all three real-robot case pairs omit the first two source
frames (0.25 seconds at 8 fps). RGB movies and their point-cloud atlases are
trimmed together; source frame counts and trim offsets are recorded in metadata.
The initial observation remains the original conditioning image.
