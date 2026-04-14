import { Request, Response } from "express";
import { logRequest, jsonify } from "../log";
import { zPostIntentsSplitData } from "../gen/zod.gen";
import { z, ZodError } from "zod";

type SplitData = z.infer<typeof zPostIntentsSplitData>

export const intent_split = async (req: Request, resp: Response) => {
    logRequest(req)

    try {
        const params = zPostIntentsSplitData.parse({
            body: req.body,
            query: undefined,
            path: undefined,
            headers: req.headers
        })

        const body = createSplitResponse(params)
        console.log('Response: ', jsonify(body))
        resp.status(200).json(body)
    } catch (e) {
        console.log(e)

        if (e instanceof ZodError) {
            resp.status(400).json({ 'error': `${e}` })
        } else {
            resp.status(500).json({ 'error': `${e}` })
        }
    }
}

function createSplitResponse(data: SplitData) {
    const tokens = data.body?.tokens ?? {}

    // Mock has infinite liquidity — return all tokens as a single intent
    const intent: Record<string, string> = {}
    for (const [address, amount] of Object.entries(tokens)) {
        intent[address] = amount.toString()
    }

    return {
        intents: Object.keys(intent).length > 0 ? [intent] : []
    }
}
