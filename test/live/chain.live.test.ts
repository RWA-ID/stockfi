// Live smoke tests against Robinhood Chain. Skipped unless LIVE=1.
import { describe, expect, it } from "vitest";
import { makeClient, ViemChainReader } from "../../src/data/chain";

const AAPL = "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9";
const live = process.env.LIVE === "1";

describe.skipIf(!live)("live chain reads", () => {
  const r = new ViemChainReader(makeClient([process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com"]));
  it("reads AAPL pools and quotes", async () => {
    const pools = await r.pools(AAPL);
    console.log(pools);
    expect(pools.length).toBeGreaterThan(0);
    const buy = await r.quote(AAPL, "buy", 5000, pools[0]!.mid, pools);
    const sell = await r.quote(AAPL, "sell", 5000, pools[0]!.mid, pools);
    console.log({ buy, sell });
  }, 60_000);
});
