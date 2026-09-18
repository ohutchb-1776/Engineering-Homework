import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { applySetbacks, classifyEdges, uniformYard } from "../src/lib/geometry/setbacks";
import { makeProjector, signedArea, toCounterClockwise } from "../src/lib/geometry/project";

const square: [number, number][] = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];

describe("applySetbacks", () => {
  it("shrinks a square by a uniform yard", () => {
    assert.equal(applySetbacks(square, [10, 10, 10, 10]).areaSf, 6400);
  });

  it("applies a different yard to each lot line", () => {
    // Edges run bottom, right, top, left. 25 ft off bottom and top leaves 50 ft
    // of depth; 8 ft off each side leaves 84 ft of width.
    assert.equal(applySetbacks(square, [25, 8, 25, 8]).areaSf, 50 * 84);
  });

  it("returns zero when the yards consume the lot", () => {
    const result = applySetbacks(square, [60, 60, 60, 60]);
    assert.equal(result.areaSf, 0);
    assert.equal(result.polygons.length, 0);
  });

  it("gives the same answer for a clockwise ring", () => {
    const clockwise: [number, number][] = [
      [0, 0],
      [0, 100],
      [100, 100],
      [100, 0],
    ];
    assert.equal(applySetbacks(clockwise, [10, 10, 10, 10]).areaSf, 6400);
  });

  it("handles an L-shaped lot without producing negative area", () => {
    const lShape: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 40],
      [40, 40],
      [40, 100],
      [0, 100],
    ];
    const result = applySetbacks(lShape, new Array(6).fill(10));
    assert.ok(result.areaSf > 0, "an L-shaped lot should retain buildable area");
    // Half-plane clipping is conservative: never more than the naive answer.
    assert.ok(result.areaSf < 100 * 100 - 60 * 60);
  });

  it("ignores zero-width yards", () => {
    assert.equal(applySetbacks(square, [0, 0, 0, 0]).areaSf, 10000);
  });
});

describe("classifyEdges", () => {
  it("identifies the lot line nearest a street as the frontage", () => {
    // Street runs along y = -20, i.e. below edge 0 of the square.
    const street: [number, number][] = [
      [-200, -20],
      [200, -20],
    ];
    const classes = classifyEdges(square, [street]);
    assert.ok(classes);
    assert.equal(classes[0], "front");
    assert.equal(classes[2], "rear");
    assert.equal(classes[1], "side");
    assert.equal(classes[3], "side");
  });

  it("returns null when there is no street to measure against", () => {
    assert.equal(classifyEdges(square, []), null);
  });
});

describe("uniformYard", () => {
  it("is the largest required yard", () => {
    assert.equal(uniformYard({ front: 25, side: 8, rear: 20 }), 25);
  });
});

describe("makeProjector", () => {
  it("round-trips a point through feet and back", () => {
    const projector = makeProjector([-70.2568, 43.6591]);
    const start: [number, number] = [-70.2548, 43.6601];
    const [lon, lat] = projector.toLonLat(projector.toFeet(start));
    assert.ok(Math.abs(lon - start[0]) < 1e-9);
    assert.ok(Math.abs(lat - start[1]) < 1e-9);
  });

  it("measures a known distance in feet", () => {
    const projector = makeProjector([-70.2568, 43.6591]);
    // 0.001 degrees of latitude is about 364 ft at this latitude.
    const [, y] = projector.toFeet([-70.2568, 43.6601]);
    assert.ok(Math.abs(y - 364.5) < 2, `expected ~364.5 ft, got ${y}`);
  });
});

describe("ring orientation", () => {
  it("normalises a clockwise ring to counter-clockwise", () => {
    const clockwise: [number, number][] = [
      [0, 0],
      [0, 10],
      [10, 10],
      [10, 0],
    ];
    assert.ok(signedArea(toCounterClockwise(clockwise)) > 0);
  });
});
