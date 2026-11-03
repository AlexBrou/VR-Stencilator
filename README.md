# VR-Stencilator

Web tools for tracing pictures onto walls with a Meta Quest headset.

- **Maker** (`index.html`) turns any image into a tracing outline: edge outline, ink lines, or paint by numbers with a color key. It can rotate the image, add an alignment grid, and save PNGs with a transparent background.
- **AR** (`ar.html`) shows those images on a real wall or table in Quest passthrough. You set up the surface, place the image once, and switch between layers (for example outline, final painting, both) while you draw.

Everything runs in the browser. Images never leave your device.

## Use it

Open the site in the **Meta Quest browser**:

- AR: https://alexbrou.github.io/VR-Stencilator/ar.html
- Maker: https://alexbrou.github.io/VR-Stencilator/

AR needs `https://`, which GitHub Pages provides.

### AR in short

1. Add your layers (all the same pixel size; Maker exports always match) and press **Start AR**.
2. Menu → **Surface → Wall** (or Floor / table): touch the surface with a controller and pull the trigger, move about 50 cm, then touch and pull again.
3. Point at the surface and pull the trigger to place the image. Then **Lock** it.
4. Next time, the placement is restored automatically. **Save project** keeps layers, settings and placement in a .zip.

Controls:
- Right stick: rotate / resize. Right trigger + stick: depth.
- Left stick: opacity. Left trigger + stick: fine slide along the surface.
- A / X: next layer. B / Y: bring the menu in front of you.
- With hands, tap menu buttons with a fingertip. The ☰ button on your left wrist brings the menu within reach.
- **More ⚙** in the menu: grid size and squares, when to show the grid, forget the saved placement, exit.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Maker page |
| `trace-core.js` | Image processing for the Maker (outline, ink lines, paint by numbers) |
| `ar.html`, `ar.js` | AR page and logic (WebXR, three.js) |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |

Libraries are loaded from CDNs: [three.js](https://threejs.org) 0.170.0 and [JSZip](https://stuk.github.io/jszip/) 3.10.1.
