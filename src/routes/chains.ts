import { Request, Response } from "express";
import { logRequest, jsonify } from "../log";
import { chainContexts } from "../chains";

export const chains = async (req: Request, resp: Response) => {
    logRequest(req)

    const contexts = chainContexts()
    const result: Record<string, { name: string; supportedTokens: { symbol: string; address: string; decimals: number }[]; testnet: boolean }> = {}

    for (const [chainId, ctx] of Object.entries(contexts)) {
        result[chainId] = {
            name: ctx.chainName,
            supportedTokens: ctx.supportedTokens().map((symbol) => ({
                symbol,
                address: ctx.getTokenAddress(symbol),
                decimals: ctx.tokenDecimals(symbol) ?? 0
            })),
            testnet: ctx.isTestnet
        }
    }

    console.log('Response: ', jsonify(result))
    resp.status(200).json(result)
}
