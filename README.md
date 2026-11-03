# Black Hole — real-time general-relativistic ray tracer in the browser

A scientifically accurate, interactive visualization of a **Schwarzschild or Kerr (rotating) black hole** with a thin accretion disk, rendered in real time with WebGL2. Every pixel is a photon traced backwards along an exact geodesic of curved spacetime. The shadow, the photon ring, the warped disk and the lensed star field are not drawn by hand: they come out of the physics.

The whole computation runs on the viewer's GPU. The server only serves about 60 KB of static files, so it runs on the smallest VPS.

## Features

- **Two metrics.** Switch between Schwarzschild and Kerr in the panel, and set the spin `a` from −0.998 to 0.998 (Thorne limit). A negative spin means a retrograde disk.
- **Exact null geodesics.** Each ray solves the Binet equation `u'' + u = 3Mu²` (u = 1/r) with an adaptive-step RK4 integrator.
- **Shadow and photon ring.** The shadow edge matches the critical impact parameter `b = √27 M` to better than 0.01%. Higher-order images of the disk form the photon ring.
- **Kerr geodesics.** Rays are traced in Boyer–Lindquist coordinates using the constants of motion E, L_z and Carter's Q. The integrator uses second-order Mino-time equations `r̈ = R'/2`, `μ̈ = Θ'/2`, so there are no sign flips at turning points. The velocities are projected back onto the first integrals, and the polar coordinate singularity is handled analytically. The camera is a zero-angular-momentum observer (ZAMO), so frame dragging is included.
- **Kerr shadow.** The shadow is D-shaped and flattened on the co-rotating side. An optional overlay draws Bardeen's analytic critical curve.
- **Accretion disk.** A geometrically thin, optically thick disk extends from the ISCO (`r = 6M`). Gas follows Keplerian orbits, and the temperature profile is `T ∝ r^(-3/4) (1 − √(6M/r))^(1/4)`.
- **Kerr disk.** The inner edge sits at ISCO(a), from 1.24M to 9M. Emission follows the full Novikov–Thorne (Page–Thorne) flux, and gas orbits at `Ω = 1/(r^{3/2} + a)`.
- **Doppler shift and beaming.** The full redshift factor `g = √(1 − 3M/r) / (1 − Ω·L_z/E)` combines the relativistic Doppler effect, transverse Doppler and gravitational redshift. Because `I_ν/ν³` is invariant, the observed spectrum is a Planck spectrum at temperature `g·T`. The approaching side looks brighter and bluer.
- **Physically based color.** Blackbody spectrum → CIE 1931 XYZ → linear sRGB, then HDR, a bloom that models the observer's optics, and ACES tone mapping.
- **Gravitationally lensed sky.** A procedural star field and Milky Way are lensed with surface brightness conserved (Liouville's theorem). Einstein rings and secondary star images appear on their own.
- **Science views.** A redshift map `g` with iso-contours, and an image-order map that separates primary, secondary and higher-order images.
- **Free camera.** Edge-on view by default, presets for M87* (17°), 60° and face-on, plus drag, zoom and pinch.
- **Adaptive resolution.** The ray-tracing resolution drops automatically to keep the frame rate smooth on integrated GPUs.

## Tech stack

- Plain HTML + ES modules + GLSL ES 3.00 (WebGL2). There are **no dependencies and no build step**.
- A tiny static server written with the Python 3 standard library (`serve.py`).
- Physics tests run on Node.js, using the same integrator as the shader.

## Getting started

Requirements: Python 3.8+ on the server, and a browser with WebGL2 and `EXT_color_buffer_float` (any current Chrome, Firefox, Safari or Edge).

```bash
git clone https://github.com/Ivanch9/black-hole.git
cd black-hole
./start.sh                    # serves on 127.0.0.1:8080
```

Then open http://localhost:8080.

### Remote server

Option 1: keep the server private and use an SSH tunnel.

```bash
ssh -L 8080:localhost:8080 <user>@<server>
# open http://localhost:8080 locally
```

Option 2: expose the server publicly.

```bash
./start.sh --host 0.0.0.0     # http://<server-ip>:8080
```

Stop the server:

```bash
pkill -f "^python3 serve.py"
```

`serve.py` options: `--host` (default `127.0.0.1`) and `--port` (default `8080`).

### Environment variables

None. All configuration is passed as command-line arguments.

## Controls

| Action | Input |
| --- | --- |
| Rotate view | drag with mouse or finger |
| Distance | mouse wheel or pinch |
| Toggle panel | `H` |
| Pause time | `Space` |
| Reset | `R` |

The current view and settings are stored in the URL hash, so you can share a link to a specific view.

## Tests

```bash
node tests/physics.test.mjs
```

The tests check:
- the shadow radius against `√27 M` for every quality preset;
- light deflection against the weak-field series `4M/b + 15π/4·M²/b² + 128/3·M³/b³`;
- the direction transform for a static observer;
- the Doppler sign and magnitude;
- the location of the disk temperature peak;
- the blackbody colors.

For Kerr, the tests check:
- the horizon, ISCO and photon orbit radii;
- the Page–Thorne flux against a direct numerical integral, for several spins;
- the initial-condition constraints;
- that the Kerr tracer at `a = 0` reproduces the Schwarzschild tracer, including rays passing over the pole;
- the shadow edges at `a = 0.9` against Bardeen's analytic curve.

## Project structure

```
index.html              UI layout and styles
js/main.js              WebGL2 setup, render loop, bloom, adaptive resolution
js/physics.js           Blackbody LUT, disk model, reference CPU ray tracer
js/camera.js            Orbit camera and pointer/touch controls
js/ui.js                Control panel
shaders/blackhole.frag  Geodesic ray tracer, disk shading, lensed sky
shaders/bloom.frag      Dual-filter bloom pyramid
shaders/post.frag       Exposure, ACES tone mapping, sRGB output
tests/physics.test.mjs  Physics verification
serve.py, start.sh      Static file server and launcher
```

## Model limitations

- In Schwarzschild mode the disk temperature uses the Newtonian Shakura–Sunyaev profile. Kerr mode uses the full relativistic Novikov–Thorne flux.
- The plunging region inside the ISCO does not emit light.
- Light travel time across the disk is ignored.
- Units are geometric (`G = c = M = 1`). In physical units, 1 M of time is about 20 s for Sgr A* and about 9 h for M87*.

## License

[MIT](LICENSE)
