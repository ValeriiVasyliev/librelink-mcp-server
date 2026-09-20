#!/usr/bin/env node

import { GlucoseAnalytics } from './dist/glucose-analytics.js';

/**
 * Assertion suite for the glucose analytics module.
 *
 * The regressions this locks down all share one shape: the module reporting a
 * reassuring finding it had no data to support. Timestamps are built in local
 * time because the time-of-day windows use getHours().
 */

let failures = 0;
let checks = 0;

function check(label, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail !== undefined ? ` -- got ${JSON.stringify(detail)}` : ''}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

const config = (low = 70, high = 180) => ({
  credentials: { email: '', password: '' },
  client: { version: '4.12.0', region: 'EU' },
  cache: { enabled: false, ttl_minutes: 5 },
  ranges: { target_low: low, target_high: high }
});

/** Build readings at `stepMinutes` spacing starting from a local wall-clock time. */
function series(values, { hour = 10, minute = 0, day = 20, stepMinutes = 15 } = {}) {
  const start = new Date(2026, 8, day, hour, minute).getTime();
  return values.map((value, i) => ({
    value,
    timestamp: new Date(start + i * stepMinutes * 60 * 1000),
    trend: 'Flat',
    isHigh: value > 180,
    isLow: value < 70,
    color: value > 180 ? 'red' : value < 70 ? 'orange' : 'green'
  }));
}

const analytics = new GlucoseAnalytics(config());

// Today's real curve: morning drift, a hypo, then the rebound to 322.
const REAL_DAY = [
  139, 119, 123, 125, 106, 100, 113, 95, 81, 76, 86, 105, 118, 106, 80,
  65, 62, 67, 90, 114, 130, 135, 136, 151, 171, 184, 193, 211, 247, 280,
  284, 279, 285, 293, 299, 303, 311, 322, 311, 298, 289, 272, 244, 229, 241, 243
];

section('1. Sparse data must not produce reassuring findings');
{
  const t = analytics.analyzeTrends(series([139, 119]), 'weekly', 168);
  const joined = t.patterns.join(' | ').toLowerCase();

  check('overnightStability is null, not 0', t.overnightStability === null, t.overnightStability);
  check('mealResponse is null, not 0', t.mealResponse === null, t.mealResponse);
  check('no "stable overnight" claim', !joined.includes('stable overnight'), t.patterns);
  check('no "excellent" claim', !joined.includes('excellent'), t.patterns);
  check('no "good" claim', !joined.includes('good'), t.patterns);
  check('overnight gap is explained', t.notAssessed.some(n => n.startsWith('Overnight stability:')), t.notAssessed);
  check('truncation is reported', t.coverage.truncated === true, t.coverage);
}

section('2. Dawn phenomenon needs a 04:00 baseline');
{
  // Flat 150s at 08:00 only. The old code read the missing 04:00 bucket as 0.
  const t = analytics.analyzeTrends(series([150, 150, 150, 150], { hour: 8 }), 'weekly');
  check('dawnPhenomenon is null without a baseline', t.dawnPhenomenon === null, t.dawnPhenomenon);
  check('no dawn pattern emitted', !t.patterns.join(' ').includes('Dawn'), t.patterns);
  check('reason is given', t.notAssessed.some(n => n.includes('Dawn phenomenon:')), t.notAssessed);
}

section('3. A genuine dawn rise is still detected');
{
  // 04:00 near 95, climbing to ~145 by 08:00, at 30-minute spacing.
  const t = analytics.analyzeTrends(
    series([95, 96, 98, 101, 110, 118, 127, 136, 145], { hour: 4, minute: 0, stepMinutes: 30 }),
    'weekly'
  );
  check('dawnPhenomenon is true', t.dawnPhenomenon === true, t.dawnPhenomenon);
  check('rise is described', t.patterns.some(p => p.includes('Dawn phenomenon detected')), t.patterns);
}

section('4. The real day is characterised correctly');
{
  const t = analytics.analyzeTrends(series(REAL_DAY, { hour: 10, minute: 58 }), 'weekly', 168);
  const joined = t.patterns.join(' | ');

  check('the 260 mg/dL climb is found', t.largestExcursion === 260, t.largestExcursion);
  check('it is called large', joined.includes('Large glucose excursions'), t.patterns);
  check('NOT called good control', !joined.toLowerCase().includes('good postprandial'), t.patterns);

  check('one hypo event', t.hypoglycemicEvents.length === 1, t.hypoglycemicEvents);
  check('hypo lasts 30 min', t.hypoglycemicEvents[0]?.durationMinutes === 30, t.hypoglycemicEvents[0]);
  check('hypo nadir is 62', t.hypoglycemicEvents[0]?.extremeValue === 62, t.hypoglycemicEvents[0]);

  check('one hyper period', t.hyperglycemicPeriods.length === 1, t.hyperglycemicPeriods);
  check('hyper lasts 300 min', t.hyperglycemicPeriods[0]?.durationMinutes === 300, t.hyperglycemicPeriods[0]);
  check('hyper peak is 322', t.hyperglycemicPeriods[0]?.extremeValue === 322, t.hyperglycemicPeriods[0]);
}

section('5. Event duration comes from timestamps, not reading counts');
{
  // Two separate 2-hour highs with a 6-hour in-range gap between them.
  const high = new Array(9).fill(250);
  const first = series(high, { hour: 2 });
  const second = series(high, { hour: 10 });
  const t = analytics.analyzeTrends([...first, ...second], 'weekly');

  check('counted as two periods, not one', t.hyperglycemicPeriods.length === 2, t.hyperglycemicPeriods.length);
  check('each is 120 min', t.hyperglycemicPeriods.every(p => p.durationMinutes === 120),
    t.hyperglycemicPeriods.map(p => p.durationMinutes));
}

section('6. Brief excursions below the event threshold are not events');
{
  // A single reading under 70 spans no measurable time.
  const t = analytics.analyzeTrends(series([120, 110, 65, 110, 120]), 'weekly');
  check('no hypo event from one reading', t.hypoglycemicEvents.length === 0, t.hypoglycemicEvents);
}

section('7. GMI is withheld below 14 days');
{
  const short = analytics.calculateGlucoseStats(series(REAL_DAY, { hour: 10, minute: 58 }), 168);
  check('gmi is null for an 11h window', short.gmi === null, short.gmi);
  check('reason is given', short.caveats.some(c => c.startsWith('GMI not reported')), short.caveats);
  check('truncation is flagged', short.caveats.some(c => c.includes('of the 168h requested')), short.caveats);
  check('average still computed', short.average === 180.67, short.average);

  // 15 days at hourly spacing.
  const long = series(new Array(24 * 15).fill(150), { day: 1, stepMinutes: 60 });
  const stats = analytics.calculateGlucoseStats(long, 24 * 15);
  check('gmi is computed at 15 days', typeof stats.gmi === 'number', stats.gmi);
  check('gmi value is right', stats.gmi === 6.90, stats.gmi);
  check('no truncation caveat', !stats.coverage.truncated, stats.coverage);
}

section('8. Configured ranges are honoured');
{
  const tight = new GlucoseAnalytics(config(80, 140));
  const stats = tight.calculateGlucoseStats(series([75, 100, 120, 160, 200]));
  check('below 80 counted', stats.timeBelowRange === 20, stats.timeBelowRange);
  check('above 140 counted', stats.timeAboveRange === 40, stats.timeAboveRange);
  check('in 80-140 counted', stats.timeInRange === 40, stats.timeInRange);
  check('percentages sum to 100',
    Math.abs(stats.timeInRange + stats.timeBelowRange + stats.timeAboveRange - 100) < 0.01);
}

section('9. Unsorted input is handled');
{
  const ordered = series(REAL_DAY, { hour: 10, minute: 58 });
  const shuffled = [...ordered].reverse();
  const a = analytics.analyzeTrends(ordered, 'weekly');
  const b = analytics.analyzeTrends(shuffled, 'weekly');
  check('same largest excursion', a.largestExcursion === b.largestExcursion, [a.largestExcursion, b.largestExcursion]);
  check('same hypo count', a.hypoglycemicEvents.length === b.hypoglycemicEvents.length);
  check('same coverage span', a.coverage.spanHours === b.coverage.spanHours, [a.coverage.spanHours, b.coverage.spanHours]);
}

section('10. Empty input still throws');
{
  let threwStats = false;
  let threwTrends = false;
  try { analytics.calculateGlucoseStats([]); } catch { threwStats = true; }
  try { analytics.analyzeTrends([]); } catch { threwTrends = true; }
  check('calculateGlucoseStats throws', threwStats);
  check('analyzeTrends throws', threwTrends);
}

console.log(`\n${failures === 0 ? '✅' : '❌'} ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
