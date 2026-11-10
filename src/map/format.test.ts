import { describe, expect, it } from 'vitest';
import { formatDurationField, parseDuration, parseNumber } from './format';

describe('panel field parsing', () => {
  it('reads durations in seconds, clock form and unit form, with an optional T- or "in" prefix', () => {
    expect(parseDuration('90')).toBe(90);
    expect(parseDuration('12,5')).toBe(12.5);
    expect(parseDuration('1:30')).toBe(90);
    expect(parseDuration('2:03:04.5')).toBe(2 * 3600 + 3 * 60 + 4.5);
    expect(parseDuration('1:02:03:04')).toBe(86400 + 2 * 3600 + 3 * 60 + 4);
    expect(parseDuration('1h 30m')).toBe(5400);
    expect(parseDuration('2d4h')).toBe(2 * 86400 + 4 * 3600);
    expect(parseDuration('1.5h')).toBe(5400);
    expect(parseDuration('90 s')).toBe(90);
    expect(parseDuration('5 min')).toBe(300);
    expect(parseDuration('T-1h 02m 03.4s')).toBeCloseTo(3723.4, 9);
    expect(parseDuration('T− 45s')).toBe(45);
    expect(parseDuration('in 10m')).toBe(600);
    for (const bad of ['', 'soon', '1h30', '1:2:3:4:5', '-5', '1h foo', '5ms']) expect(parseDuration(bad), bad).toBeNaN();
  });

  it('formats a field duration that reads back to the same tenth of a second', () => {
    for (const s of [0, 0.04, 9.95, 59.96, 61.2, 3599.94, 3723.4, 86399.96, 2 * 86400 + 3 * 3600 + 4 * 60 + 5, 1e7 + 0.3]) {
      const text = formatDurationField(s);
      expect(parseDuration(text), text).toBeCloseTo(Math.round(s * 10) / 10, 6);
    }
    expect(formatDurationField(3723.4)).toBe('1h 02m 03.4s');
    expect(formatDurationField(245)).toBe('4m 05.0s');
    expect(formatDurationField(12.5)).toBe('12.5s');
  });

  it('reads numbers with a comma or point and an optional unit', () => {
    expect(parseNumber('25')).toBe(25);
    expect(parseNumber('-3,5')).toBe(-3.5);
    expect(parseNumber('12.5 m/s', 'm/s')).toBe(12.5);
    expect(parseNumber('889001500.0 s', 's')).toBe(889001500);
    expect(parseNumber('.5')).toBe(0.5);
    for (const bad of ['', 'abc', '1.2.3', '5 km/s', '--1']) expect(parseNumber(bad, 'm/s'), bad).toBeNaN();
  });
});
