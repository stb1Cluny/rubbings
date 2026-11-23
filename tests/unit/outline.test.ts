import { describe, expect, it } from 'vitest';
import { MAX_SIZE_MM, MIN_SHORT_SIDE_MM, OUTLINES, edgeDistance, plateShape } from '../../src/shapes/outline';

describe('plateShape', () => {
  it('lists "None" first, as the default choice', () => {
    expect(OUTLINES[0].kind).toBe('none');
  });

  it('"None" takes the picture\'s proportions, longest side at the chosen size', () => {
    expect(plateShape('none', 120, false, 3 / 2)).toEqual({ ellipse: false, width: 120, height: 80 });
    expect(plateShape('none', 120, false, 2 / 3)).toEqual({ ellipse: false, width: 80, height: 120 });
    expect(plateShape('none', 100, false, 1)).toEqual({ ellipse: false, width: 100, height: 100 });
  });

  it('"None" ignores the orientation switch and bad aspect values', () => {
    expect(plateShape('none', 120, true, 2 / 3)).toEqual(plateShape('none', 120, false, 2 / 3));
    expect(plateShape('none', 100, false, 0)).toEqual({ ellipse: false, width: 100, height: 100 });
    expect(plateShape('none', 100, false, NaN)).toEqual({ ellipse: false, width: 100, height: 100 });
  });

  it('"None" keeps very long, thin pictures printable', () => {
    const banner = plateShape('none', 60, false, 12);
    expect(banner.height).toBeCloseTo(MIN_SHORT_SIDE_MM, 6);
    expect(banner.width).toBeCloseTo(120, 6);
    expect(banner.width / banner.height).toBeCloseTo(12, 6);
    // Past the maximum plate size the short side has to give.
    const ribbon = plateShape('none', 60, false, 50);
    expect(ribbon.width).toBe(MAX_SIZE_MM);
    expect(ribbon.width / ribbon.height).toBeCloseTo(50, 6);
  });

  it('paper sizes are true size and turn with the orientation', () => {
    expect(plateShape('a4', 0, false)).toEqual({ ellipse: false, width: 210, height: 297 });
    expect(plateShape('a4', 0, true)).toEqual({ ellipse: false, width: 297, height: 210 });
    expect(plateShape('letter', 0, false)).toEqual({ ellipse: false, width: 215.9, height: 279.4 });
  });

  it('user-sized outlines clamp to the allowed range', () => {
    expect(plateShape('circle', 1000, false).width).toBe(MAX_SIZE_MM);
    expect(plateShape('oval', 120, false)).toEqual({ ellipse: true, width: 90, height: 120 });
  });
});

describe('edgeDistance', () => {
  it('is exact for rectangles and close for circles near the edge', () => {
    const square = plateShape('square', 40, false);
    expect(edgeDistance(square, 0, 0)).toBe(20);
    expect(edgeDistance(square, 18, 5)).toBeCloseTo(2, 6);
    expect(edgeDistance(square, 25, 0)).toBeLessThan(0);
    const circle = plateShape('circle', 100, false);
    expect(edgeDistance(circle, 48, 0)).toBeCloseTo(2, 1);
    expect(edgeDistance(circle, 0, -49)).toBeCloseTo(1, 1);
    expect(edgeDistance(circle, 51, 0)).toBeLessThan(0);
  });
});
