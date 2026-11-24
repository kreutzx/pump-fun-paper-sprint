// Momentum paper-trading bot for the make.fun pump.fun replay (agent-fun/replay/v2).
//
// Strategy: follow short-term momentum on freshly created pump.fun curves.
// For every mint we keep a short ring of spot-price samples (virtual quote /
// virtual token reserves, sampled once per batch in which the mint trades).
// When the price has risen at least MOMENTUM_MIN over the last LOOKBACK samples
// and the curve holds enough real SOL for a meaningful fill, we buy a fixed
// stake. Positions exit on a take-profit, a stop-loss, or a maximum hold time,
// whichever comes first. A mint is bought at most once per run, which spreads
// the book across many coins instead of concentrating on a few.
//
// Deterministic by construction: no clock, no randomness, no network, no
// environment reads. Iteration follows Map insertion order everywhere.
//
// Run by the grader as `node /bot/main.ts`; the SDK shim is vendored beside
// this file (vendor/makefun-bot.ts, a byte-identical copy of the kit's
// sdk/ts/makefun-bot.ts).

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

// ---- parameters -----------------------------------------------------------

const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 6n) / 100n; // 0.06 SOL per entry
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL: the guardrail round-trip floor
const MIN_REAL_RESERVE = LAMPORTS_PER_SOL * 2n; // only trade curves holding >= 2 SOL real
const LOOKBACK = 10; // samples of momentum history required and compared against
const MIN_TRADES = 20; // ignore curves with thin flow: their samples are noise
const SAMPLE_RING = 16; // samples kept per mint
const MOMENTUM_MIN = 0.12; // +12% over the lookback window triggers an entry: the first
// local grade showed +6% entries mostly bought local tops (win rate under 0.30), so the
// trigger now demands a move strong enough to still be running after the 2-slot latency
const TAKE_PROFIT = 1.18; // exit when position value reaches 1.18x its cost: bank the
// move early instead of waiting for +30% that pump curves rarely sustain
const STOP_LOSS = 0.9; // exit when position value falls to 0.90x its cost: pump curves that
// break down rarely recover, so the stop stays tighter than the take-profit is wide
const MAX_HOLD_SLOTS = 400; // exit regardless after this many slots
const STALE_SLOTS = 6000; // forget mints with no trade for this many slots
const BUY_SLIPPAGE_BPS = 1_000;
const SELL_SLIPPAGE_BPS = 1_500;

// ---- per-mint state -------------------------------------------------------

interface MintState {
  /** Recent spot prices (lamports per token, scaled), oldest first. */
  samples: number[];
  lastSeenSlot: number;
  trades: number;
}

const mints = new Map<string, MintState>();
/** Mints already bought once this run: never re-entered. */
const traded = new Set<string>();
/** Slot at which each held position was first observed. */
const entrySlot = new Map<string, number>();

function spotPrice(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

await runBot({
  onBatch(state, batch) {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: (BuyInput | SellInput)[] = [];

    // -- 1. sample prices for every mint that traded in this batch ----------
    const active = new Set<string>();
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      active.add(e.mint);
    }
    for (const mint of active) {
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      let ms = mints.get(mint);
      if (ms === undefined) {
        ms = { samples: [], lastSeenSlot: batch.slot, trades: 0 };
        mints.set(mint, ms);
      }
      ms.lastSeenSlot = batch.slot;
      ms.trades = curve.trades;
      const price = spotPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (price > 0) {
        ms.samples.push(price);
        if (ms.samples.length > SAMPLE_RING) ms.samples.shift();
      }
    }

    // -- 2. exits: take-profit, stop-loss, time stop ------------------------
    const pendingSells = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSells.add(p.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      if (!entrySlot.has(mint)) entrySlot.set(mint, batch.slot);
      if (pendingSells.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      const value = spotPrice(curve.virtual_quote_reserves, curve.virtual_token_reserves) * Number(holding.token_amount);
      const ratio = value / Number(holding.cost_lamports);
      const heldSlots = batch.slot - (entrySlot.get(mint) ?? batch.slot);
      if (curve.complete || ratio >= TAKE_PROFIT || ratio <= STOP_LOSS || heldSlots >= MAX_HOLD_SLOTS) {
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }
    // Forget entry slots for positions that are gone.
    for (const mint of [...entrySlot.keys()]) {
      if (!state.positions.has(mint)) entrySlot.delete(mint);
    }

    // -- 3. entries: momentum breakouts on fresh curves ---------------------
    let free = state.freeCashLamports();
    // Sells decided above pay a tx fee each if they fill; keep a cash buffer.
    free -= BigInt(orders.length) * tx;
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const mint of active) {
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) break;
      if (traded.has(mint) || state.positions.has(mint)) continue;
      let pendingBuy = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === mint) pendingBuy = true;
      }
      if (pendingBuy) continue;
      const ms = mints.get(mint);
      const curve = state.curves.get(mint);
      if (ms === undefined || curve === undefined || curve.complete) continue;
      if (ms.samples.length <= LOOKBACK) continue;
      if (ms.trades < MIN_TRADES) continue;
      if (curve.real_quote_reserves < MIN_REAL_RESERVE) continue;
      const now = ms.samples[ms.samples.length - 1];
      const then = ms.samples[ms.samples.length - 1 - LOOKBACK];
      if (then <= 0 || now / then - 1 < MOMENTUM_MIN) continue;
      const cap = state.maxBuyLamports(mint);
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      traded.add(mint);
      free -= amount + tx;
      slots -= 1;
    }

    // -- 4. prune stale mint state to bound memory --------------------------
    if (batch.seq % 512 === 0) {
      for (const [mint, ms] of mints) {
        if (batch.slot - ms.lastSeenSlot > STALE_SLOTS && !state.positions.has(mint)) {
          mints.delete(mint);
        }
      }
    }

    return orders;
  },
});
