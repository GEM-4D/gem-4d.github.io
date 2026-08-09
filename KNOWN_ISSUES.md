# Known issues

## The rollout viewer looks broken on this laptop's integrated GPU (2026-08-06)

**Symptom.** On the development laptop, the WebGL point-cloud rollout in the hero
stutters and roughly one frame in seven collapses: the picture keeps its vertical
structure (curtain, floor) but every row is smeared into a single horizontal band
of colour. Reproduces in both Chrome and Firefox.

**It is not the page.** Reading the frame back from the GPU immediately after each
draw (`gl.readPixels` on a scanline, checking horizontal variance) found
**0 degenerate frames out of 4230**. WebGL renders correctly every time; the damage
happens after the frame leaves the GL context.

**Cause.** The laptop is a hybrid-graphics machine and the browser runs on the
integrated GPU:

| | |
|---|---|
| iGPU | AMD Radeon 780M (`gfx1103`), Mesa **23.2.1** (Ubuntu 22.04 stock) |
| dGPU | NVIDIA RTX 4070 Laptop, driver 570.211.01 |
| Session | X11, GNOME, display scaling 100% |

Screen-recording both at 60 fps and counting collapsed frames automatically:

```
iGPU (AMD / Mesa 23.2.1):   70 of 480 frames collapsed  (14.6%)
dGPU (NVIDIA / 570.211):     0 of 475 frames collapsed  ( 0.0%)
```

So it is a **Mesa bug on RDNA3 integrated graphics**, not a bug in this site, not a
browser bug, and not related to fractional display scaling.

**How to preview this site locally.** Run the browser on the discrete GPU:

```bash
__NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia google-chrome
```

To make that permanent for the desktop launcher (no system packages touched,
reversible by deleting the file):

```bash
mkdir -p ~/.local/share/applications
sed -e 's|^Exec=/usr/bin/google-chrome-stable|Exec=env __NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia /usr/bin/google-chrome-stable|' \
    /usr/share/applications/google-chrome.desktop > ~/.local/share/applications/google-chrome.desktop
update-desktop-database ~/.local/share/applications
```

**Real fix, when there is time.** Upgrade Mesa past 23.2 (e.g. the
`ppa:kisak/kisak-mesa` PPA). It does not touch the NVIDIA driver or CUDA. The one
real side effect to expect: conda environments ship their own, older `libstdc++`,
so GL programs launched from inside a conda env may then fail with
`version 'GLIBCXX_3.4.30' not found` — fixed with
`conda install -c conda-forge libstdcxx-ng`.

**Does this affect visitors?** Only those on the same narrow combination (AMD RDNA3
integrated graphics with a Mesa older than ~24). macOS, Windows, and machines with
current Mesa are unaffected. The page keeps a static poster frame behind the canvas,
so a browser without working WebGL shows the scene rather than an empty box.
