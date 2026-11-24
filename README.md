# Pump.fun Paper Sprint — Momentum Bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/kreutzx/pump-fun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/kreutzx/pump-fun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A momentum paper-trading bot for make.fun's **Pump.fun Paper Sprint: Any Bot Can Win** (`u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`), running on the `pumpfun-replay/v2` harness (protocol `agent-fun/replay/v2`). Paper trading only: the replay uses market data, never real funds.

## Strategy

`main.ts` samples each coin's spot price (virtual quote / virtual token reserves) once per batch in which it trades. When the price has risen at least 12% over the last 10 samples, the mint has at least 20 trades, the curve holds at least 2 SOL of real reserves, and a position slot is free, it buys a fixed 0.06 SOL stake (capped by the harness's per-mint size cap). Positions exit at +18% take-profit, −10% stop-loss, or after 400 slots, whichever comes first. On the kit's dev window it completes 265 round trips of at least 0.01 SOL with a max drawdown under 7% (guardrails met). Each mint is bought at most once per run, spreading the book across many coins. The bot is fully deterministic: no clock, no randomness, no network.

The kit's TypeScript SDK shim is vendored at `vendor/makefun-bot.ts` (byte-identical to the kit's `sdk/ts/makefun-bot.ts`); the strategy itself is dependency-free.

## Run it

```sh
node main.ts
```

The bot speaks the replay protocol on stdin/stdout (one JSON line per harness message); in grading it is run by the harness as `node /bot/main.ts`. To grade it locally on the competition's dev window, use the kit's CLI: `node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process` from inside the unpacked kit.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
