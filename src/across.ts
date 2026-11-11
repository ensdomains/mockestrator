import { Address, encodeFunctionData, erc20Abi, getAddress, Hash, Hex, hashStruct, keccak256, parseSignature, TypedDataDefinition, zeroAddress } from "viem";
import { z } from "zod";
import { erc2612Abi, PERMIT2_ADDRESS, permit2Abi } from "./abi/permit2";
import { AddressSchema, BigIntSchema, ChainContext, VarHex } from "./chains";

// Rhinestone's Across arbiter, the same address on every chain. A wallet only
// signs a Permit2 transfer whose spender is this, so the mock quotes it too.
export const ACROSS_ARBITER: Address = "0xA162fabb9a0EeF2736485A587aAAB3d015e14224"

// The real orchestrator quotes Across routes for two minutes; clients refuse a
// permit that stays signable for much longer.
export const ACROSS_QUOTE_LIFETIME_S = 120

// The witness the SDK has the wallet sign (getTypedData in @rhinestone/sdk's
// execution/permit2), minus the PermitBatchWitnessTransferFrom it is wrapped in.
export const mandateTypes = {
    Token: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
    ],
    Target: [
        { name: "recipient", type: "address" },
        { name: "tokenOut", type: "Token[]" },
        { name: "targetChain", type: "uint256" },
        { name: "fillExpiry", type: "uint256" },
    ],
    Ops: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
    ],
    Op: [
        { name: "vt", type: "bytes32" },
        { name: "ops", type: "Ops[]" },
    ],
    Mandate: [
        { name: "target", type: "Target" },
        { name: "minGas", type: "uint128" },
        { name: "originOps", type: "Op" },
        { name: "destOps", type: "Op" },
        { name: "q", type: "bytes32" },
    ],
} as const

// What Permit2 appends to "PermitBatchWitnessTransferFrom(...,uint256 deadline,":
// the witness field, then every referenced struct in EIP-712 (alphabetical) order.
export const MANDATE_WITNESS_TYPE_STRING =
    "Mandate mandate)" +
    "Mandate(Target target,uint128 minGas,Op originOps,Op destOps,bytes32 q)" +
    "Op(bytes32 vt,Ops[] ops)" +
    "Ops(address to,uint256 value,bytes data)" +
    "Target(address recipient,Token[] tokenOut,uint256 targetChain,uint256 fillExpiry)" +
    "Token(address token,uint256 amount)" +
    "TokenPermissions(address token,uint256 amount)"

const toToken = (id: bigint): Address => getAddress(`0x${(id & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}`)

const OpSchema = z.object({
    vt: VarHex,
    ops: z.array(z.object({ to: AddressSchema, value: BigIntSchema, data: VarHex })),
})

const AcrossElementSchema = z.object({
    arbiter: AddressSchema,
    chainId: BigIntSchema,
    idsAndAmounts: z.array(z.tuple([BigIntSchema, BigIntSchema])),
    mandate: z.object({
        recipient: AddressSchema,
        tokenOut: z.array(z.tuple([BigIntSchema, BigIntSchema])),
        destinationChainId: BigIntSchema,
        fillDeadline: BigIntSchema,
        minGas: BigIntSchema,
        preClaimOps: OpSchema,
        destinationOps: OpSchema,
        qualifier: z.object({ encodedVal: VarHex }),
    }),
})

export type AcrossElement = z.infer<typeof AcrossElementSchema>

export const parseAcrossElement = (element: unknown): AcrossElement => AcrossElementSchema.parse(element)

/** The witness hash Permit2 checks the wallet's signature against. */
export const mandateWitness = ({ mandate }: AcrossElement): Hash =>
    hashStruct({
        types: mandateTypes,
        primaryType: "Mandate",
        data: {
            target: {
                recipient: mandate.recipient,
                tokenOut: mandate.tokenOut.map(([id, amount]) => ({ token: toToken(id), amount })),
                targetChain: mandate.destinationChainId,
                fillExpiry: mandate.fillDeadline,
            },
            minGas: mandate.minGas,
            originOps: mandate.preClaimOps,
            destOps: mandate.destinationOps,
            q: keccak256(mandate.qualifier.encodedVal),
        },
    })

/**
 * The source-chain side of each requested destination token: the token of the
 * same symbol on the source chain, for the same amount (the mock bridges at no
 * fee). Any L2 in chains.json can be a source as long as it lists the symbol.
 * Permit2 moves ERC-20s only, so a native token cannot be bridged this way.
 */
export const acrossLegs = (
    source: ChainContext,
    destination: ChainContext,
    tokenRequests: readonly { tokenAddress: string, amount?: bigint | number | string | null }[],
): { token: Address, amount: bigint }[] =>
    tokenRequests.map((transfer) => {
        const symbol = destination.symbolOf(getAddress(transfer.tokenAddress))
        if (!symbol) {
            throw new Error(`${transfer.tokenAddress} is not a known token on ${destination.chainId}`)
        }
        const token = source.maybeAddress(symbol)
        if (!token) {
            throw new Error(`${symbol} is not configured on source chain ${source.chainId}`)
        }
        if (token == zeroAddress) {
            throw new Error(`Across routes bridge ERC-20s only, not native ${symbol}`)
        }
        return { token, amount: BigInt(transfer.amount ?? 0n) }
    })

/**
 * The ERC-2612 permit that lets Permit2 pull `value` of `token` from `owner`,
 * or undefined when the allowance already covers it. Its deadline is the
 * intent's, which the fill relies on (see pullAcrossDeposit).
 */
export const approvalPermit = async (
    source: ChainContext,
    owner: Address,
    token: Address,
    value: bigint,
    deadline: bigint,
): Promise<TypedDataDefinition | undefined> => {
    const client = source.client
    const allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, PERMIT2_ADDRESS] })
    if (allowance >= value) {
        return undefined
    }
    const [name, version, nonce] = await Promise.all([
        client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
        client.readContract({ address: token, abi: erc2612Abi, functionName: "version" }),
        client.readContract({ address: token, abi: erc2612Abi, functionName: "nonces", args: [owner] }),
    ])
    return {
        domain: { name, version, chainId: source.chainId, verifyingContract: token },
        types: {
            Permit: [
                { name: "owner", type: "address" },
                { name: "spender", type: "address" },
                { name: "value", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" },
            ],
        },
        primaryType: "Permit",
        message: { owner, spender: PERMIT2_ADDRESS, value, nonce, deadline },
    }
}

export const PermitSignaturesSchema = z.record(z.string(), z.record(AddressSchema, VarHex)).optional()

export type PermitSignatures = z.infer<typeof PermitSignaturesSchema>

/**
 * The origin leg of an Across fill: apply any ERC-2612 approval the wallet
 * signed, then pull the permitted tokens through Permit2 as the arbiter. Permit2
 * verifies the wallet's witness signature, so a wrong signature or witness
 * reverts here, as it would for the real relayer.
 */
export const pullAcrossDeposit = async (params: {
    source: ChainContext
    sponsor: Address
    nonce: bigint
    expires: bigint
    element: AcrossElement
    originSignature: Hex
    permitSignatures: PermitSignatures
}): Promise<Hash> => {
    const { source, sponsor, nonce, expires, element, originSignature, permitSignatures } = params
    const permitted = element.idsAndAmounts.map(([id, amount]) => ({ token: toToken(id), amount }))

    // Every approval permit the route asks for is for the permitted amount and
    // expires with the intent (approvalPermit), so its terms need not be stored.
    for (const [token, signature] of Object.entries(permitSignatures?.[source.chainId] ?? {})) {
        const amount = permitted.find((p) => p.token.toLowerCase() == token.toLowerCase())?.amount
        if (amount == undefined) {
            throw new Error(`Approval permit for ${token}, which the intent does not spend`)
        }
        const { v, yParity, r, s } = parseSignature(signature as Hex)
        await source.execute({
            to: token as Address,
            callData: encodeFunctionData({
                abi: erc2612Abi,
                functionName: "permit",
                args: [sponsor, PERMIT2_ADDRESS, amount, expires, Number(v ?? 27n + BigInt(yParity)), r, s],
            }),
            value: 0n,
        })
    }

    return source.sendAs(element.arbiter, {
        to: PERMIT2_ADDRESS,
        callData: encodeFunctionData({
            abi: permit2Abi,
            functionName: "permitWitnessTransferFrom",
            args: [
                { permitted, nonce, deadline: expires },
                permitted.map(({ amount }) => ({ to: source.client.account.address, requestedAmount: amount })),
                sponsor,
                mandateWitness(element),
                MANDATE_WITNESS_TYPE_STRING,
                originSignature,
            ],
        }),
    })
}
