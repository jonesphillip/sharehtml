import { pixelPositionsEqual } from "../src/client/pixel-positions.js";

describe("pixelPositionsEqual", () => {
  it("is true for identical reports (the live-clock / no-op case)", () => {
    expect(pixelPositionsEqual({ a: 10, b: 20 }, { a: 10, b: 20 })).toBe(true);
    expect(pixelPositionsEqual({}, {})).toBe(true);
  });

  it("is false when an anchor moves", () => {
    expect(pixelPositionsEqual({ a: 10 }, { a: 11 })).toBe(false);
  });

  it("is false when an anchor is added or removed", () => {
    expect(pixelPositionsEqual({ a: 10 }, { a: 10, b: 20 })).toBe(false);
    expect(pixelPositionsEqual({ a: 10, b: 20 }, { a: 10 })).toBe(false);
  });
});
