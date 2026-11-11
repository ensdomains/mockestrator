## Mockestrator - test your app with mocked Orchestrator as a pro ##

### Pulling image form the public ECR

https://gallery.ecr.aws/rhinestone/mockestrator

```
docker pull public.ecr.aws/rhinestone/mockestrator:latest
```

## ENS fork (`ensdomains/mockestrator`)

The ENS apps e2e suite runs this fork, published as
`ghcr.io/ensdomains/mockestrator:sha-<commit>` by `.github/workflows/release-ghcr.yaml`
and pinned by digest in the apps-monorepo `e2e/infra/docker-compose.yml`.

### Which API this fork serves

The fork serves the API version that the ENS apps' `@rhinestone/sdk` speaks, not
upstream's. `src/version.ts` refuses any other `x-api-version` with a 400.

| `@rhinestone/sdk` | Orchestrator API | Mockestrator |
|---|---|---|
| 1.x (apps on 1.22.0) | `2026-01.alps`: `POST /intents/route`, `/intent-operations` | **this fork's `main`** |
| 2.x | `2026-04.blanc`: `POST /quotes`, `/intents` | `rhinestonewtf/mockestrator` `main` (from 7cc49b1) |
| 3.x | `2026-09.caucasus` | not yet upstream |

Do not merge upstream `main` into this fork while the apps are on SDK 1.x.
Upstream's blanc migration replaces every alps route. Move the fork when the apps
bump the SDK, in the same piece of work. `alps-d1390c0` tags the last alps
`main` before the L2 work.

### What the fork adds on top of upstream `4e876ba`

Port these when moving to a newer upstream. In upstream's blanc layout,
`routes/intent_route.ts` becomes `routes/quote.ts` and `routes/intent_store.ts`
becomes `routes/intents.ts`. `chains.ts` stays where it is.

1. Skip setupOps for deployed accounts. Execute directly by impersonating the account (#1).
2. Return `targetExecutionNonce` in the route response, for SDK ≥ 1.4.2 (#3).
3. Fund ETH and ERC20s before impersonating in `executeAsAccount`.
4. Redirect `ox/tempo` imports in tsconfig.
5. Use the gas-refund IntentExecutor variant when the signature commits to one (#4), with mode 0x05 byte offsets (#5).
6. Read the source chain from SDK 1.22's `accountAccessList.chainTokens`, which the generated schema strips.
7. Across routes from any configured L2 (`src/across.ts`):
   - the route returns a Permit2 witness transfer to Rhinestone's arbiter, plus an ERC-2612 approval permit;
   - the fill pulls the deposit through the real Permit2 on the source fork, then fills on the destination.
   - Chains marked `"optional": true` in `rpcs.json` are skipped when they are unreachable.
8. The `x-api-version` guard (`src/version.ts`).

### Adding an L2

1. Add the chain to `rpcs.json` with `"optional": true`.
2. Add its tokens to `chains.json` under the same symbols as the destination chain (Circle USDC: `balanceSlot` 9, `approvalSlot` 10).
3. Check that Permit2 and the Across arbiter are deployed on it.

`acrossLegs` maps tokens by symbol, so no code change is needed.
