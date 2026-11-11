import { describe, expect, it } from 'vitest';
import { formatDurationField, formatTimeTo, formatUtDate, parseDuration, parseNumber, parseUtDate } from './format';

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
    // the HUD's countdown notation (minus sign, no-break space), to a tenth of a second
    expect(formatDurationField(3723.4)).toBe('T− 1:02:03.4');
    expect(formatDurationField(245)).toBe('T− 4:05.0');
    expect(formatDurationField(12.5)).toBe('T− 0:12.5');
    expect(formatDurationField(2 * 86400 + 3 * 3600 + 4 * 60 + 5)).toBe('T− 2d 03:04:05.0');
    expect(parseDuration('2d 03:04:05')).toBe(2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  });

  it('writes time-to-event in one notation everywhere (labels, tooltips, panel): the HUD countdown', () => {
    expect(formatTimeTo(90)).toBe('T− 1:30');
    expect(formatTimeTo(5400)).toBe('T− 1:30:00');
    expect(formatTimeTo(3 * 86400 + 18 * 3600 + 51 * 60 + 7)).toBe('T− 3d 18:51');
    expect(formatTimeTo(-12)).toBe('T+ 0:12');
    expect(formatTimeTo(0.4)).toBe('now');
  });

  it('shows and reads the node time as calendar time in the HUD clock format (UTC, J2000 = 2000-01-01 12:00)', () => {
    expect(formatUtDate(0)).toBe('2000-01-01 12:00:00');
    expect(formatUtDate(889001500)).toBe('2028-03-03 20:51:40');
    expect(parseUtDate('2028-03-03 20:51:40')).toBe(889001500);
    expect(parseUtDate('2028-03-03T20:51:40.5 UTC')).toBe(889001500.5);
    expect(parseUtDate('2028-03-03 20:51')).toBe(889001460);
    for (const bad of ['', '2028-13-01 00:00', '2028-03-03', 'tomorrow', '2028-03-03 25:00']) expect(parseUtDate(bad), bad).toBeNaN();
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
