// BTC trend bot: buy early and hold, with a 3% trailing stop.
// Long only, no shorts, no leverage. One symbol, CBBTC.
// Buy the full cash balance on the first tradable bar. After that,
// track the highest close since entry. Sell everything if the close
// falls 3% below that peak. That caps the loss on a falling race
// window at about 3% plus fees, while a rising or flat window keeps
// the position, like buy-and-hold. Re-enter only on a clear recovery:
// either the close makes a new high above the exit peak, or it is
// 3% above the trough since the exit and above the 120-bar average.
// No clock, no randomness, no network, no files outside the repo.
// Every decision is a pure function of the bars seen so far, so two
// runs on the same data give the same orders.

import { runBars, type BarsState } from './vendor/makefun-bars.ts';

const MAX_SLIPPAGE_BPS = 10_000;
const STOP_NUM = 97n;
const STOP_DEN = 100n;
const REENTRY_NUM = 103n;
const REENTRY_DEN = 100n;
const SMA_BARS = 120;

const closes: bigint[] = [];
let peak: bigint | null = null;
let exitPeak: bigint | null = null;
let trough: bigint | null = null;
let bought = false;

function sma120(): bigint | null {
  if (closes.length < SMA_BARS) return null;
  let sum = 0n;
  for (let i = closes.length - SMA_BARS; i < closes.length; i++) sum += closes[i]!;
  return sum / BigInt(SMA_BARS);
}

await runBars({
  onBatch(state: BarsState) {
    if (state.warmingUp) return [];
    const close = state.close('CBBTC');
    if (close === null) return [];
    closes.push(close);

    const held = state.positions.get('CBBTC');
    const qty = held ? held.qty : 0n;

    if (qty > 0n) {
      if (peak === null || close > peak) peak = close;
      // Sell everything if the close is 3% below the peak.
      if (peak !== null && close * STOP_DEN < peak * STOP_NUM) {
        exitPeak = peak;
        trough = close;
        peak = null;
        bought = false;
        return [{ side: 'sell', symbol: 'CBBTC', qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // In cash.
    if (trough !== null && close < trough) trough = close;
    if (!bought) {
      // First trade: buy the full cash balance.
      bought = true;
      peak = close;
      trough = null;
      exitPeak = null;
      const { caps, fees } = state.hello;
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / 10000n;
      const slice = state.cash < byWeight ? state.cash : byWeight;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
      return [{ side: 'buy', symbol: 'CBBTC', notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }

    // Re-entry after a stop-out.
    if (exitPeak === null || trough === null) return [];
    const newHigh = close > exitPeak;
    const avg = sma120();
    const recovered = close * REENTRY_DEN > trough * REENTRY_NUM && avg !== null && close > avg;
    if (newHigh || recovered) {
      peak = close;
      trough = null;
      exitPeak = null;
      const { caps, fees } = state.hello;
      const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / 10000n;
      const slice = state.cash < byWeight ? state.cash : byWeight;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) return [];
      return [{ side: 'buy', symbol: 'CBBTC', notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
