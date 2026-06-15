// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for `cropGeometry` — the pure letterbox transform + quad
 * helpers behind the item-7 draggable-corner crop editor
 * (`RectCropPreview`).
 *
 * Pure-TS per jest.config.js (no RN preset).  `cropGeometry` has no React
 * or native imports, so it runs as-is with no module stubbing — unlike the
 * sensor-backed hooks.
 *
 * Covers:
 *   - contain-fit round-trip identity (screen → image → screen) across
 *     wide/tall/square letterboxes,
 *   - degenerate layout passthrough + out-of-bounds clamping,
 *   - quad validity (valid accepted, degenerate + non-convex rejected),
 *   - canonical corner ordering ([TL, TR, BR, BL]) from shuffled input,
 *   - rect sizing from a known skewed quad,
 *   - axis-aligned detection for the cropToRect-vs-cropToQuad decision.
 */
import {
  containFit,
  imageToScreen,
  isAxisAlignedRect,
  isQuadValid,
  orderQuadCorners,
  rectSizeForQuad,
  screenToImage,
  signedArea2,
  type Point,
  type Quad,
} from '../cropGeometry';

/** Approx-equality for floating-point round-trips. */
function expectClose(a: Point, b: Point, eps = 1e-6): void {
  expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(eps);
  expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(eps);
}

describe('containFit', () => {
  // Image 200×100 into a 400×400 box → scale 2, letterboxed top/bottom
  // (dispH 200, so 100px bars top + bottom), no horizontal bars.
  it('letterboxes a wide image vertically (top/bottom bars)', () => {
    const fit = containFit({ width: 400, height: 400 }, 200, 100);
    expect(fit).not.toBeNull();
    expect(fit!.scale).toBe(2);
    expect(fit!.offX).toBe(0);
    expect(fit!.offY).toBe(100);
  });

  // Image 100×200 into a 400×400 box → scale 2, letterboxed left/right.
  it('letterboxes a tall image horizontally (left/right bars)', () => {
    const fit = containFit({ width: 400, height: 400 }, 100, 200);
    expect(fit!.scale).toBe(2);
    expect(fit!.offX).toBe(100);
    expect(fit!.offY).toBe(0);
  });

  it.each([
    ['zero box width', { width: 0, height: 400 }, 200, 100],
    ['zero box height', { width: 400, height: 0 }, 200, 100],
    ['zero image width', { width: 400, height: 400 }, 0, 100],
    ['zero image height', { width: 400, height: 400 }, 200, 0],
  ])('returns null for degenerate layout: %s', (_label, layout, iw, ih) => {
    expect(containFit(layout as { width: number; height: number }, iw as number, ih as number)).toBeNull();
  });
});

describe('screen↔image round-trip (letterbox identity)', () => {
  // Each row: a descriptive layout + image size + an in-bounds image point.
  // image → screen → image must be the identity (within fp epsilon).
  const cases: {
    label: string;
    layout: { width: number; height: number };
    iw: number;
    ih: number;
    pts: Point[];
  }[] = [
    {
      label: 'wide image, vertical letterbox',
      layout: { width: 400, height: 400 },
      iw: 200,
      ih: 100,
      pts: [
        { x: 0, y: 0 },
        { x: 200, y: 100 },
        { x: 100, y: 50 },
        { x: 37, y: 88 },
      ],
    },
    {
      label: 'tall image, horizontal letterbox',
      layout: { width: 300, height: 600 },
      iw: 100,
      ih: 200,
      pts: [
        { x: 0, y: 0 },
        { x: 100, y: 200 },
        { x: 50, y: 123 },
      ],
    },
    {
      label: 'square image, square box (no bars)',
      layout: { width: 512, height: 512 },
      iw: 256,
      ih: 256,
      pts: [
        { x: 0, y: 0 },
        { x: 256, y: 256 },
        { x: 128, y: 64 },
      ],
    },
    {
      label: 'non-integer scale',
      layout: { width: 333, height: 250 },
      iw: 1000,
      ih: 750,
      pts: [
        { x: 250, y: 125 },
        { x: 999, y: 1 },
      ],
    },
  ];

  it.each(cases)(
    'image → screen → image is identity ($label)',
    ({ layout, iw, ih, pts }) => {
      for (const imgPt of pts) {
        const screen = imageToScreen(imgPt, layout, iw, ih);
        const back = screenToImage(screen, layout, iw, ih);
        expectClose(back, imgPt);
      }
    },
  );

  it.each(cases)(
    'screen → image → screen is identity for in-image screen points ($label)',
    ({ layout, iw, ih, pts }) => {
      // Derive in-bounds screen points by projecting the image points,
      // then assert the reverse round-trip holds too.
      for (const imgPt of pts) {
        const screen = imageToScreen(imgPt, layout, iw, ih);
        const image = screenToImage(screen, layout, iw, ih);
        const screen2 = imageToScreen(image, layout, iw, ih);
        expectClose(screen2, screen);
      }
    },
  );

  it('clamps an out-of-image screen point into image bounds', () => {
    const layout = { width: 400, height: 400 };
    // Wide image → top bar is the region y∈[0,100). A touch up there maps
    // to a negative image-y, which must clamp to 0; likewise far-right.
    const inBar = screenToImage({ x: -50, y: 10 }, layout, 200, 100);
    expect(inBar.x).toBe(0);
    expect(inBar.y).toBe(0);
    const beyond = screenToImage({ x: 9999, y: 9999 }, layout, 200, 100);
    expect(beyond.x).toBe(200);
    expect(beyond.y).toBe(100);
  });

  it('passes the point through unchanged when layout is degenerate', () => {
    const p = { x: 12, y: 34 };
    expect(screenToImage(p, { width: 0, height: 0 }, 200, 100)).toEqual(p);
    expect(imageToScreen(p, { width: 0, height: 0 }, 200, 100)).toEqual(p);
  });
});

describe('orderQuadCorners', () => {
  // Canonical rect corners, then a shuffled presentation of them.
  const tl: Point = { x: 0, y: 0 };
  const tr: Point = { x: 10, y: 0 };
  const br: Point = { x: 10, y: 8 };
  const bl: Point = { x: 0, y: 8 };

  it('orders a shuffled axis-aligned rect to [TL, TR, BR, BL]', () => {
    const shuffled: Quad = [br, tl, bl, tr];
    expect(orderQuadCorners(shuffled)).toEqual([tl, tr, br, bl]);
  });

  it('orders a perspective-skewed quad to [TL, TR, BR, BL]', () => {
    // Trapezoid: top edge narrower than bottom (typical keystone).
    const sTL: Point = { x: 3, y: 1 };
    const sTR: Point = { x: 9, y: 0 };
    const sBR: Point = { x: 12, y: 10 };
    const sBL: Point = { x: 0, y: 9 };
    const shuffled: Quad = [sBL, sTR, sBR, sTL];
    expect(orderQuadCorners(shuffled)).toEqual([sTL, sTR, sBR, sBL]);
  });
});

describe('signedArea2', () => {
  // Shoelace sign follows winding in MATH coords (y-up).  In the editor's
  // screen coords (y-DOWN), the visual sense flips — so the [TL, TR, BR,
  // BL] order the overlay uses traces a positive shoelace.  We just assert
  // the sign-by-winding contract + magnitude = 2×area here; isQuadValid
  // only uses |signedArea2|, so the absolute sign never matters downstream.
  it('flips sign with winding and has magnitude 2×area', () => {
    // 10×8 rect → area 80 → |signedArea2| = 160.
    const wind1: Quad = [
      { x: 0, y: 0 },
      { x: 0, y: 8 },
      { x: 10, y: 8 },
      { x: 10, y: 0 },
    ];
    const wind2: Quad = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 8 },
      { x: 0, y: 8 },
    ];
    expect(Math.abs(signedArea2(wind1))).toBe(160);
    expect(Math.abs(signedArea2(wind2))).toBe(160);
    // Reversing the winding flips the sign.
    expect(Math.sign(signedArea2(wind1))).toBe(-Math.sign(signedArea2(wind2)));
  });
});

describe('isQuadValid', () => {
  it('accepts a valid convex rect', () => {
    const rect: Quad = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 8 },
      { x: 0, y: 8 },
    ];
    expect(isQuadValid(rect)).toBe(true);
  });

  it('accepts a valid convex perspective trapezoid', () => {
    const trap: Quad = [
      { x: 3, y: 0 },
      { x: 9, y: 0 },
      { x: 12, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(isQuadValid(trap)).toBe(true);
  });

  it('rejects a degenerate (zero-area / collinear) quad', () => {
    const line: Quad = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 15, y: 0 },
    ];
    expect(isQuadValid(line)).toBe(false);
  });

  it('rejects a quad below the minimum-area threshold', () => {
    // 1×1 quad → area 1 → below default minArea 1? area === minArea is
    // the boundary; use a clearly sub-threshold sliver.
    const sliver: Quad = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0.05 },
      { x: 0, y: 0.05 },
    ];
    expect(isQuadValid(sliver, 1)).toBe(false);
  });

  it('rejects a self-intersecting (bowtie / non-convex) quad', () => {
    // Swapping two adjacent corners produces a crossed "bowtie".
    const bowtie: Quad = [
      { x: 0, y: 0 },
      { x: 10, y: 8 },
      { x: 10, y: 0 },
      { x: 0, y: 8 },
    ];
    expect(isQuadValid(bowtie)).toBe(false);
  });

  it('rejects a concave (dented) quad', () => {
    // Push the BR corner inward past the diagonal → reflex angle.
    const concave: Quad = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 4 },
      { x: 0, y: 10 },
    ];
    expect(isQuadValid(concave)).toBe(false);
  });
});

describe('rectSizeForQuad', () => {
  it('sizes an axis-aligned rect to its exact dimensions', () => {
    const rect: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ];
    expect(rectSizeForQuad(rect)).toEqual({ w: 100, h: 60 });
  });

  it('averages opposite edge lengths for a skewed quad', () => {
    // Top edge 80 wide, bottom edge 120 wide → avg w 100.
    // Left edge 60 tall, right edge 60 tall → h 60.
    const trap: Quad = [
      { x: 20, y: 0 }, // TL
      { x: 100, y: 0 }, // TR  (top = 80)
      { x: 120, y: 60 }, // BR
      { x: 0, y: 60 }, // BL  (bottom = 120)
    ];
    const size = rectSizeForQuad(trap);
    expect(size.w).toBe(100); // (80 + 120) / 2
    // left = dist(TL,BL) = hypot(20,60) ≈ 63.25; right = dist(TR,BR) =
    // hypot(20,60) ≈ 63.25 → round(63.25) = 63.
    expect(size.h).toBe(63);
  });
});

describe('isAxisAlignedRect', () => {
  it('is true for a perfectly axis-aligned rect', () => {
    const rect: Quad = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ];
    expect(isAxisAlignedRect(rect)).toBe(true);
  });

  it('is true within the pixel tolerance (sub-pixel skew)', () => {
    const nearRect: Quad = [
      { x: 0, y: 0.4 },
      { x: 100, y: 0 },
      { x: 100.3, y: 60 },
      { x: 0, y: 60.2 },
    ];
    expect(isAxisAlignedRect(nearRect, 1)).toBe(true);
  });

  it('is false for a clearly skewed (perspective) quad', () => {
    const trap: Quad = [
      { x: 20, y: 0 },
      { x: 100, y: 0 },
      { x: 120, y: 60 },
      { x: 0, y: 60 },
    ];
    expect(isAxisAlignedRect(trap, 1)).toBe(false);
  });
});
