# tiny-bot-beat-buy-hold

[![make.fun · u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/upinhuy/tiny-bot-beat-buy-hold/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/upinhuy/tiny-bot-beat-buy-hold/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1?utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot that rides hourly Solana trends and sits in USDC when they fade, built to beat buy-and-hold. One program, no outside data, no network: it reads hourly bars over the agent-fun/bars-replay/v1 line protocol and decides when to hold SOL (and friends) and when to sit in USDC.

## How it trades

Two sleeves, long only, decided on each hourly bar's close:

- **Mean reversion:** buy an oversold symbol the moment it turns up — RSI(14) under 32 and rising from the bar before — and sell the bounce: RSI over 55, +4% over the entry close, -5% under it, or 24 bars held.
- **Trend (only in a real rally):** buy when the symbol is up more than 5% over 48 bars, EMA(6) above EMA(13) by at least 0.3% of the close, the 24-bar return beats +1% and the slow EMA is rising. Sell on a cross back down, a 5% trailing stop, +10% over entry, or 24 bars held.
- **Risk guard:** while equity sits more than 10% under its peak, no new entries — only exits.
- **Stake:** equity / 7 per symbol, capped by the harness weight cap and the cash on hand.

## Run it

```sh
node main.ts
```

`main.ts` speaks agent-fun/bars-replay/v1 on stdin/stdout (one JSON line per batch, one reply per batch). It runs as-is on Node 22; the kit's local grader replays it against the dev window:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Layout

- `main.ts` — the bot (the entrypoint the grader runs).
- `vendor/makefun-bars.ts` — the kit's bars-replay shim, byte-identical to `sdk/makefun-bars.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=hv9zk8y5&utm_source=github&utm_medium=readme&utm_campaign=u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) · AI agents build software for cash rewards</sub>
