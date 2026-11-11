import { Request, Response } from "express";
import { jsonify, logRequest } from "../log";
import { zPostIntentsRouteData, zPostIntentsRouteResponse } from "../gen/zod.gen";
import { z, ZodError } from "zod";
import { Address, getAddress, hexToBigInt, TypedDataDefinition } from "viem";
import { randomBytes } from "crypto";
import { chainContext, chainContexts } from "../chains";
import { ACROSS_ARBITER, ACROSS_QUOTE_LIFETIME_S, acrossLegs, approvalPermit } from "../across";
import { PERMIT2_ADDRESS } from "../abi/permit2";

type UserIntent = z.infer<typeof zPostIntentsRouteData>

type UserIntentRouteResponse = z.infer<typeof zPostIntentsRouteResponse>

type AccountAccessListType = NonNullable<UserIntent["body"]>["accountAccessList"];

export const intent_route = async (req: Request, resp: Response) => {
    logRequest(req)

    try {
        const params = zPostIntentsRouteData.parse({
            body: req.body,
            query: undefined,
            path: undefined,
            headers: req.headers
        })
        const body = await create_intent_route({
            ...params,
        }, req.body?.accountAccessList)
        console.log('Response: ', jsonify(body))
        resp.status(201).json(body)
    } catch (e) {
        console.log(e)

        if (e instanceof ZodError) {
            resp.status(400).json({
                'error': `${e}`
            })
        } else {
            resp.status(500).json({
                'error': `${e}`
            })
        }
    }
}

const create_intent_route = async (data: UserIntent, rawAccessList: unknown): Promise<UserIntentRouteResponse> => {

    const userIntent = data.body!

    const sponsor = getAddress(userIntent.account.address)

    const maxNonce = (1n << 63n) - 1n
    const randomBigInt = (hexToBigInt('0x' + randomBytes(8).toString('hex') as `0x${string}`) % maxNonce) + 1n

    const currentDate = Math.floor(Date.now() / 1000);

    const destinatinoChain = userIntent.destinationChainId
    const sourceChain = chainTokensSource(rawAccessList) ?? extractSourceChain(userIntent.accountAccessList)
    const isAcross = sourceChain != destinatinoChain

    // Same-chain intents keep paying the sponsor; an Across route pays the
    // requested recipient (e.g. a smart account funded from the user's wallet)
    const recipient = isAcross && userIntent.recipient ? getAddress(userIntent.recipient.address) : sponsor
    // do we need it or we can put to random value
    const arbiter = isAcross ? ACROSS_ARBITER : "0xdead00000000000000000000000000000000beef"
    // An Across permit is checked against the source chain's clock, which a
    // fork may have warped away from ours, so it expires by that clock
    const expires = isAcross
        ? Number((await chainContext(sourceChain).client.getBlock()).timestamp) + ACROSS_QUOTE_LIFETIME_S
        : currentDate + 3600

    const across = isAcross ? await quoteAcross(sourceChain, destinatinoChain, sponsor, userIntent.tokenRequests, BigInt(expires)) : undefined

    const qualifier = (() => {
        if (sourceChain == destinatinoChain) {
            return {
                settlementContext: {
                    settlementLayer: "INTENT_EXECUTOR" as const,
                    fundingMethod: "NO_FUNDING" as const,
                    using7579: true as const,
                    gasRefund: {
                        overhead: 0n,
                        exchangeRate: 0n,
                        token: "0x0000000000000000000000000000000000000000"
                    }
                },
                encodedVal: "0xff"
            }
        } else {
            return {
                settlementContext: {
                    settlementLayer: "ACROSS" as const,
                    fundingMethod: "PERMIT2" as const,
                    using7579: true
                },
                encodedVal: "0xff"
            }
        }
    })()


    const tokenOut = userIntent.tokenRequests.map((transfer) => {
        // TODO: a check if token is supported by our mock system?

        return [hexToBigInt(transfer.tokenAddress as Address), transfer.amount]
    })

    return {
        intentOp: {
            sponsor,
            nonce: randomBigInt,
            expires: BigInt(expires),
            // SDK 1.4.2 expects targetExecutionNonce for getTargetExecutionMessage
            targetExecutionNonce: 0n,
            elements: [
                {
                    arbiter,
                    chainId: BigInt(sourceChain),
                    idsAndAmounts: across?.idsAndAmounts ?? [],
                    spendTokens: [],
                    mandate: {
                        recipient,
                        tokenOut,
                        destinationChainId: BigInt(userIntent.destinationChainId),
                        fillDeadline: BigInt(expires),
                        // SDK 1.1.0 expects Op struct with { vt, ops } format
                        preClaimOps: { vt: "0x0000000000000000000000000000000000000000000000000000000000000000", ops: [] },
                        destinationOps: { vt: "0x0201000000000000000000000000000000000000000000000000000000000000", ops: userIntent.destinationExecutions ?? [] },
                        qualifier,
                        minGas: 0n
                    }
                }
            ],
            serverSignature: "4f8c3b1d2f3a7e61c8f4a9170a4b2f8e5c9d0b6a3c7e8f4a9172b3c1d4e5f6a0",  // random, doesn't mean anything
            signedMetadata: {
                tokenPrices: {
                    "ETH": 123,
                    "USDC": 123,
                    "WETH": 123,
                    "USDT0": 123,
                    "USDT": 123,
                    "BNB": 123,
                    "WBNB": 123,
                    "XDAI": 123,
                    "POL": 123,
                    "WPOL": 123,
                    "S": 123,
                    "WS": 123,
                    "HYPE": 123,
                    "WHYPE": 123,
                    "XPL": 123,
                    "WXPL": 123,
                    "MockUSD": 123
                },

                gasPrices: {},
                account: { ...userIntent.account, accountContext: {} },
                opGasParams: {},
            }
        },
        intentCost: {
            hasFulfilledAll: true,
            tokensSpent: {},
            tokensReceived: userIntent.tokenRequests.map((transfer) => ({
                tokenAddress: transfer.tokenAddress,
                amountSpent: transfer.amount ?? 0n,
                targetAmount: transfer.amount ?? 0n,
                fee: 0n,
                feeBreakdown: {
                    gasFee: 0n,
                    bridgeFee: 0n,
                    protocolFee: 0n,
                    swapFee: 0n,
                    settlementFee: 0n
                },
                feesByToken: {},
                hasFulfilled: true
            })),
            sponsorFee: {
                relayer: 0,
                protocol: 0
            },
            gasCost: {
                originChains: [],
                destination: { chainId: destinatinoChain, gasUSD: 0 },
                totalUSD: 0
            },
            feeBreakdownUSD: {
                gasFeeUSD: 0,
                bridgeFeeUSD: 0,
                protocolFeeUSD: 0,
                swapFeeUSD: 0,
                settlementFeeUSD: 0,
                totalFeeUSD: 0
            }
        },
        // carries an ERC-2612 permit, which the generated schema predates
        tokenRequirements: across?.tokenRequirements as UserIntentRouteResponse["tokenRequirements"],
    }
}

type TokenRequests = UserIntent["body"] extends infer B ? B extends { tokenRequests: infer T } ? T : never : never

/**
 * What an Across route moves on the source chain: the source chain's token of
 * the same symbol as each requested one, at no fee, plus an ERC-2612 permit
 * for Permit2 wherever the sponsor's allowance falls short.
 */
const quoteAcross = async (sourceChain: number, destinationChain: number, sponsor: Address, tokenRequests: TokenRequests, expires: bigint) => {
    const source = chainContext(sourceChain)
    const destination = chainContext(destinationChain)

    const legs = acrossLegs(source, destination, tokenRequests)

    const tokenRequirements: Record<string, Record<Address, { type: "approval", amount: bigint, spender: Address, permit: TypedDataDefinition }>> = {}
    for (const { token, amount } of legs) {
        const permit = await approvalPermit(source, sponsor, token, amount, expires)
        if (permit) {
            tokenRequirements[sourceChain] = {
                ...tokenRequirements[sourceChain],
                [token]: { type: "approval", amount, spender: PERMIT2_ADDRESS, permit },
            }
        }
    }

    return {
        idsAndAmounts: legs.map(({ token, amount }) => [hexToBigInt(token), amount] as [bigint, bigint]),
        tokenRequirements: Object.keys(tokenRequirements).length > 0 ? tokenRequirements : undefined,
    }
}

// SDK 1.22 sends sourceAssets as { chainTokens: { [chainId]: tokens } }, which
// the generated schema predates and strips, so it is read off the raw body
function chainTokensSource(rawAccessList: unknown): number | undefined {
    const chainTokens = (rawAccessList as { chainTokens?: Record<string, unknown> } | undefined)?.chainTokens
    const [chainId] = Object.keys(chainTokens ?? {})
    return chainId == undefined ? undefined : parseInt(chainId)
}

function extractSourceChain(accountAccessList: AccountAccessListType | undefined): number {
    if (!accountAccessList) {
        return parseInt(Object.keys(chainContexts())[0])
    }


    // Case 1: array of { chainId, tokenAddress }
    if (Array.isArray(accountAccessList) && accountAccessList.length > 0) {
        return accountAccessList[0].chainId;
    }

    // Case 2: object with optional chainIds
    if (!Array.isArray(accountAccessList) && accountAccessList.chainIds?.length) {
        return accountAccessList.chainIds[0];
    }

    throw new Error('Unreachable')
}
