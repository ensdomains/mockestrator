import { isAddress } from "viem";

// The orchestrator also takes the fee token by address (the SDK's `feeAsset` is `Address | symbol`),
// but the generated schema only lists symbols. The mock never reads it, so an address is left out of validation.
export const withoutAddressFeeToken = (body: unknown): unknown => {
    if (typeof body !== "object" || body === null) return body
    const { options } = body as { options?: unknown }
    if (typeof options !== "object" || options === null) return body
    const { feeToken, ...rest } = options as { feeToken?: unknown }
    if (typeof feeToken !== "string" || !isAddress(feeToken, { strict: false })) return body
    return { ...body, options: rest }
}
