// Tiny Bot, Easy $2 — a paper-trading bot for hourly Solana bars.
//
// Two sleeves, one program, long only, decided on each bar's close and
// filled at the next bar's open:
//
//   Mean reversion (the workhorse): buy an oversold symbol the moment it
//   turns up — RSI(14) under 32 and rising from the bar before — and sell
//   the bounce: RSI over 55, +4% over the entry close, -5% under it, or
//   24 bars held, whichever comes first. Buying the turn, not the fall,
//   is the whole point: an oversold print that is still falling keeps
//   falling more often than it bounces.
//
//   Trend (only in a real rally): buy when the symbol is up more than 5%
//   over 48 bars, EMA(6) sits above EMA(13) by at least 0.3% of the close,
//   the 24-bar return beats +1% and the slow EMA itself is rising over the
//   last 6 bars. Sell on a cross back down, a 5% trailing stop under the
//   peak close since entry, +10% over the entry close, or 24 bars held.
//   The 48-bar gate keeps this sleeve out of dead-cat bounces, so in a
//   down market it simply never fires and the bot sits in USDC.
//
//   - RSI(14) is the plain mean of the last 14 one-bar gains and losses
//     (100 when there is no loss in the window), so it needs 15 closes.
//   - The EMAs are seeded from the mean of each span's first closes, then
//     move 2 / (span + 1) of the way to each new close.
//   - Risk guard: while equity sits more than 10% under its peak, no new
//     entries — only exits — so a bad stretch cannot deepen the drawdown.
//   - Stake: equity / 7 per symbol (one slot per universe symbol), capped
//     by the harness weight cap and by the cash this reply has not spent.
//   - A reply carries the sells first, then the buys in universe order, at
//     most caps.max_orders_per_bar in all. Each order caps its slippage at
//     150 bps past the close it was decided on, so a fill into a liquidity
//     gap is refused (and retried on the next bar) rather than filled for
//     almost nothing.
//
// Determinism: the bot reads no clock, no environment and no randomness, so
// the two grading runs produce identical action logs. Diagnostics go to
// stderr only; stdout carries replies, one per batch, echoing its seq.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_SPAN = 6;
const SLOW_SPAN = 13;
const RSI_SPAN = 14;
/** Mean-reversion entry: RSI under this, and rising from the bar before. */
const MR_RSI_IN = 32;
/** Mean-reversion exit: RSI over this. */
const MR_RSI_OUT = 55;
/** Mean-reversion exit: take profit over the entry close. */
const MR_TAKE_BPS = 400;
/** Mean-reversion exit: stop loss under the entry close. */
const MR_STOP_BPS = 500;
/** Either sleeve exits after this many bars held. */
const MAX_HOLD_BARS = 24;
/** Trend entry: 48-bar return must beat this. */
const TREND_REGIME_BPS = 500;
/** Trend entry: 24-bar return must beat this. */
const TREND_MOMENTUM_BPS = 100;
/** Trend entry: fast - slow must be at least this share of the close. */
const TREND_GAP_BPS = 30;
/** Trend entry: the slow EMA must be rising over the last 6 bars. */
const SLOPE_BARS = 6;
/** Trend exit: trailing stop under the peak close since entry. */
const TREND_STOP_BPS = 500;
/** Trend exit: take profit over the entry close. */
const TREND_TAKE_BPS = 1000;
/** No new entries while equity is 10% under its peak. */
const GUARD_BPS = 1000;
const MAX_SLIPPAGE_BPS = 150;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

type Sleeve = 'mr' | 'tr';

interface Series {
  fast: Ema;
  slow: Ema;
  /** Closes, oldest first, capped at 49 (the 48-bar regime window). */
  closes: number[];
  /** Slow EMA values, oldest first, capped at SLOPE_BARS + 1. */
  slows: number[];
  /** RSI after the previous bar, once it exists. */
  prevRsi: number | null;
  /** Entry close of the current position (null while flat). */
  entry: number | null;
  /** Highest close since the current position opened (null while flat). */
  peak: number | null;
  /** Bars held of the current position. */
  held: number;
  /** Which sleeve opened the current position. */
  sleeve: Sleeve | null;
}

const series = new Map<string, Series>();
let peakEquity = 0n;

function newEma(span: number): Ema {
  return { span, warm: [], value: null };
}

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) {
    e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
  }
}

/** RSI(14) from the last RSI_SPAN one-bar changes, or null while short. */
function rsi(s: Series): number | null {
  if (s.closes.length < RSI_SPAN + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = s.closes.length - RSI_SPAN; i < s.closes.length; i++) {
    const d = s.closes[i]! - s.closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  const avgGain = gain / RSI_SPAN;
  const avgLoss = loss / RSI_SPAN;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Return over `bars` bars in bps, or null while the history is short. */
function returnBps(s: Series, bars: number): number | null {
  if (s.closes.length < bars + 1) return null;
  const first = s.closes[s.closes.length - 1 - bars]!;
  const last = s.closes[s.closes.length - 1]!;
  return ((last - first) / first) * 10_000;
}

/** Slow-EMA rise over SLOPE_BARS in bps, or null while the history is short. */
function slopeBps(s: Series): number | null {
  if (s.slows.length < SLOPE_BARS + 1) return null;
  const first = s.slows[0]!;
  const last = s.slows[s.slows.length - 1]!;
  return ((last - first) / first) * 10_000;
}

function track(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: newEma(FAST_SPAN),
      slow: newEma(SLOW_SPAN),
      closes: [],
      slows: [],
      prevRsi: null,
      entry: null,
      peak: null,
      held: 0,
      sleeve: null,
    };
    series.set(bar.symbol, s);
  }
  const close = Number(bar.c);
  s.prevRsi = rsi(s);
  step(s.fast, close);
  step(s.slow, close);
  if (s.slow.value !== null) {
    s.slows.push(s.slow.value);
    if (s.slows.length > SLOPE_BARS + 1) s.slows.shift();
  }
  s.closes.push(close);
  if (s.closes.length > 49) s.closes.shift();
  return s;
}

await runBars({
  onBatch(state: BarsState, batch: { bars: Bar[] }) {
    if (state.equity > peakEquity) peakEquity = state.equity;
    for (const bar of batch.bars) track(bar);
    // While warming up every order would be rejected (warmup): build the
    // indicators, send no orders on this batch.
    if (state.warmingUp) return [];

    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const buys: BuyInput[] = [];
    let spent = 0n;

    const guarded = (peakEquity * BigInt(10_000 - GUARD_BPS)) / 10_000n > state.equity;

    for (const symbol of state.hello.symbols.map((s) => s.symbol)) {
      const s = series.get(symbol);
      const close = state.close(symbol);
      if (s === undefined || close === null) continue;
      const price = Number(close);
      const held = state.positions.get(symbol);
      const gap = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
      const nowRsi = rsi(s);

      if (held !== undefined) {
        // Track the peak and the bars held, then decide the exit on this
        // bar's close.
        if (s.peak === null || price > s.peak) s.peak = price;
        if (s.entry === null) s.entry = price;
        s.held += 1;
        let exit = s.held >= MAX_HOLD_BARS;
        if (s.sleeve === 'mr') {
          const recovered = nowRsi !== null && nowRsi > MR_RSI_OUT;
          const tookProfit = s.entry !== null && price * 10_000 >= s.entry * (10_000 + MR_TAKE_BPS);
          const stopped = s.entry !== null && price * 10_000 <= s.entry * (10_000 - MR_STOP_BPS);
          exit = exit || recovered || tookProfit || stopped;
        } else {
          const crossDown = gap !== null && gap <= 0;
          const stopped = s.peak !== null && price * 10_000 < s.peak * (10_000 - TREND_STOP_BPS);
          const tookProfit = s.entry !== null && price * 10_000 >= s.entry * (10_000 + TREND_TAKE_BPS);
          exit = exit || crossDown || stopped || tookProfit;
        }
        if (exit) {
          s.peak = null;
          s.entry = null;
          s.held = 0;
          s.sleeve = null;
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else if (!guarded) {
        // Flat: mean reversion first — buy the oversold turn.
        const turningUp = nowRsi !== null && s.prevRsi !== null && nowRsi < MR_RSI_IN && nowRsi > s.prevRsi;
        let sleeve: Sleeve | null = turningUp ? 'mr' : null;
        if (sleeve === null) {
          // Then trend — only in a real multi-day rally.
          const regime = returnBps(s, 48);
          const momentum = returnBps(s, 24);
          const slope = slopeBps(s);
          const gapOk = gap !== null && (gap * 10_000) / price >= TREND_GAP_BPS;
          const trendUp = gap !== null && gap > 0 && s.slow.value !== null && price > s.slow.value;
          const momOk = momentum !== null && momentum > TREND_MOMENTUM_BPS;
          const regimeOk = regime !== null && regime > TREND_REGIME_BPS;
          const slopeOk = slope !== null && slope > 0;
          if (trendUp && gapOk && momOk && regimeOk && slopeOk) sleeve = 'tr';
        }
        if (sleeve !== null) {
          const slot = state.equity / BigInt(state.hello.symbols.length);
          const room = state.weightRoom(symbol);
          let size = slot < room ? slot : room;
          const cashLeft = state.cash - spent;
          if (size > cashLeft) size = cashLeft;
          if (size >= BigInt(fees.min_notional_quote_units) && size > 0n) {
            spent += size;
            s.entry = price;
            s.peak = price;
            s.held = 0;
            s.sleeve = sleeve;
            buys.push({ side: 'buy', symbol, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS });
          }
        }
      }
    }

    const orders = [...sells, ...buys].slice(0, caps.max_orders_per_bar);
    return orders;
  },
});
