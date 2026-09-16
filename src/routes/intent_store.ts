import { ZodError, z } from "zod"
import { jsonify, logRequest } from "../log"
import { Request, Response } from "express"
import { zPostIntentOperationsData, zPostIntentOperationsResponse } from "../gen/zod.gen"
import { addNewIntent } from "../services/intentRepo"
import { Address, encodeAbiParameters, encodePacked, fromHex, getAddress, Hex, pad, slice, toHex, zeroAddress } from "viem"
import { AddressSchema, BigIntSchema, chainContexts, VarHex } from "../chains"

type SignedIntentData = z.infer<typeof zPostIntentOperationsData>

type SignedIntentResponse = z.infer<typeof zPostIntentOperationsResponse>

export const intent_store = async (req: Request, resp: Response) => {
    logRequest(req)

    try {
        const params = zPostIntentOperationsData.parse({
            body: req.body,
            query: undefined,
            path: undefined,
            headers: req.headers
        })
        const body = await executeIntent({
            ...params,
        })
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

const executeIntent = async (signedIntentData: SignedIntentData): Promise<SignedIntentResponse> => {
    const signedIntent = signedIntentData.body!.signedIntentOp

    const sponsor = getAddress(signedIntent.sponsor)
    const recipient = getAddress(signedIntent.elements[0].mandate.recipient)
    const destinationChain = Number(signedIntent.elements[0].mandate.destinationChainId)
    const nonce = BigInt(signedIntent.nonce)

    const executor = chainContexts()[destinationChain]

    const destinationOps = toDestinationOpsEncoded(signedIntent.elements)
    const destinationSignature = (signedIntent.destinationSignature ?? '0x') as Hex

    const hasDestinationOps = destinationOps && destinationOps !== '0x'
    const hasValidDestinationSignature = destinationSignature &&
        destinationSignature !== '0x' &&
        destinationSignature.length > 2 &&
        !isFakeSignature(destinationSignature)

    if (hasDestinationOps && !hasValidDestinationSignature) {
        throw new Error('Destination signature required for destination operations')
    }

    let txHash: Hex

    if (hasDestinationOps) {
        console.log('Executing via IntentExecutor with signature verification')
        txHash = await executeIntentExecutorFlow({
            executor,
            signedIntent,
            sponsor,
            nonce,
            recipient,
            destinationOps,
            destinationSignature,
            gasRefund: extractGasRefund(destinationSignature),
        })
    } else {
        console.log('Executing via FakeRouter')
        txHash = await executeLegacyFlow(executor, signedIntent, recipient)
    }

    await addNewIntent(signedIntent.nonce, {
        userAddress: recipient,
        destinationChainId: BigInt(destinationChain),
        status: "COMPLETED" as const,
        fillTimestamp: Math.floor(Date.now() / 1000),
        fillTransactionHash: txHash,
        claims: []
    })

    return {
        result: {
            id: signedIntent.nonce,
            status: "PENDING"
        }
    }
}

// fallback path for intents without destination ops, intent executor requires a destination signature
const executeLegacyFlow = async (
    executor: ReturnType<typeof chainContexts>[number],
    signedIntent: any,
    recipient: Address
): Promise<Hex> => {
    const setupCalls = await getSetupCallsIfNeeded(executor, signedIntent, recipient)

    const tokenTransfers = toTokenTransfers(signedIntent.elements)
    const tokenTransferCalls = tokenTransfers
        .filter((t) => t.address != zeroAddress)
        .map((transfer) => ({
            to: transfer.address,
            callData: executor.transfer(recipient, transfer.value)
        }))

    const destinationOps = toDestinationOps(signedIntent.elements)
    const executions = [...setupCalls, ...tokenTransferCalls, ...destinationOps]

    const nativeTransferValue = tokenTransfers.filter((t) => t.address == zeroAddress).map((t) => t.value)[0] ?? 0n

    if (executions.length === 0 && nativeTransferValue === 0n) {
        return '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
    }

    if (executions.length === 0 && nativeTransferValue > 0n) {
        return executor.execute({ to: recipient, callData: '0x' as Hex, value: nativeTransferValue })
    }

    const txCallData = await executor.callFakeRouter(executions)
    return executor.execute({ ...txCallData, value: nativeTransferValue })
}

const executeIntentExecutorFlow = async (params: {
    executor: ReturnType<typeof chainContexts>[number],
    signedIntent: any,
    sponsor: Address,
    nonce: bigint,
    recipient: Address,
    destinationOps: Hex,
    destinationSignature: Hex,
    gasRefund?: { token: Address, exchangeRate: bigint, overhead: bigint }
}): Promise<Hex> => {
    const {
        executor,
        signedIntent,
        sponsor,
        nonce,
        recipient,
        destinationOps,
        destinationSignature,
        gasRefund,
    } = params
    const setupCalls = await getSetupCallsIfNeeded(executor, signedIntent, recipient)
    const isDeployed = await executor.isAccountDeployed(recipient)

    const tokenTransfers = toTokenTransfers(signedIntent.elements)
    const tokenTransferCalls = tokenTransfers
        .filter((t) => t.address != zeroAddress)
        .map((transfer) => ({
            to: transfer.address,
            callData: executor.transfer(recipient, transfer.value)
        }))

    const nativeTransferValue = tokenTransfers.filter((t) => t.address == zeroAddress).map((t) => t.value)[0] ?? 0n

    // For already-deployed accounts, execute destination ops directly as the
    // smart account (via anvil_impersonateAccount). This bypasses the intent
    // executor's on-chain signature verification which can fail in test
    // environments, and ensures the smart account is msg.sender to target
    // contracts like resolvers that check caller authorization.
    if (isDeployed && setupCalls.length === 0) {
        console.log(`Executing directly as account ${recipient} (bypassing intent executor)`)

        // Handle token transfers via router first (if any)
        if (tokenTransferCalls.length > 0) {
            const transferCallData = await executor.callFakeRouter(tokenTransferCalls)
            await executor.execute({ ...transferCallData, value: nativeTransferValue })
        }

        // Execute destination ops as the smart account
        const destOps = toDestinationOps(signedIntent.elements)
        if (destOps.length > 0) {
            return executor.executeAsAccount(
                recipient,
                destOps.map(op => ({ to: op.to, callData: op.callData }))
            )
        }

        return '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex
    }

    // Fallback: use intent executor flow (for first-time deployment etc.)
    const routerCalls = [
        ...setupCalls,
        ...tokenTransferCalls,
        executor.intentExecutorCall(sponsor, nonce, destinationOps, destinationSignature, gasRefund)
    ]

    const txCallData = await executor.callFakeRouter(routerCalls)
    const routerTxHash = await executor.execute({ ...txCallData, value: nativeTransferValue })

    return routerTxHash
}

/**
 * Reads the gas-refund terms the account actually signed for, straight out of
 * the destination signature bytes.
 *
 * These terms are baked into the EIP-712 digest the account signed
 * (`IntentExecutor.hashGasRefund`, vs. the fixed `NO_GASREFUND` hash used by
 * the plain `executeSinglechainOps`), so a fill that carries a signed refund
 * MUST go through `executeSinglechainOpsWithGasRefund_ERC20` with the EXACT
 * refund the signature commits to — calling the no-refund variant, or
 * guessing the refund from anywhere else (e.g. the route quote's
 * `mandate.qualifier.settlementContext.gasRefund`, which is only a planning
 * estimate — observed zeroed-out on real requests, not the signed terms),
 * recomputes a different digest than what was signed. The account's
 * isValidSignature check then fails, surfacing as the orchestrator's generic
 * InvalidSignature() with no further detail.
 *
 * Mirrors `HCAOwnerAndSessionValidator._validateFixedSession` as actually
 * deployed (read from the redeploy's own build-info — the checked-out
 * contracts-v2 branch is a DIFFERENT, unrelated deployment and its source
 * does not match; see contracts-v2 commit `71a3b733`'s
 * `src/hca/HCAOwnerAndSessionValidator.sol`). The validator is now
 * session-stateless: `_validateFixedSession` only accepts mode 0x04
 * (Permit2, cross-chain, no refund) or 0x05 (same-chain, this one) — the old
 * 0x01/0x02/0x03 steady-state modes no longer exist on-chain at all.
 *
 * The destination signature is `[20-byte zero routing prefix][validator
 * payload]` — accounts route ERC-7579 signatures by a leading module address,
 * which standalone-HCA intents leave zeroed. Byte offsets below are into the
 * payload, i.e. AFTER that prefix.
 *
 * Mode 0x05 layout — NOT a simple mode+permissionId+length-prefixed-proof.
 * The proof is `_decodeSessionEnableProof`'s fixed-size `SessionEnableProof`
 * struct (109 bytes) immediately after permissionId, followed by a 1-byte
 * chain count, then that many packed 40-byte (chainId ++ sessionDigest)
 * entries (`HCASmartSessionLib.AUTHORIZATION_ENTRY_LENGTH`), then a 65-byte
 * owner signature over the multi-chain authorization:
 *   mode(1) permissionId(32)
 *   [SessionEnableProof(109) chainCount(1)]           <- HEADER_LENGTH=110
 *   packedSessions(chainCount * 40) ownerSignature(65) <- proofEnd
 *   nonce(32) token(20) exchangeRate(uint96/12) refundAmount(uint96/12)
 *   gasOverhead(uint48/6)                              <- 82 bytes total
 *   operationData(var) signature(65)
 * `GasRefund.overhead` on-chain is a single packed field, not the raw
 * 6-byte gasOverhead: `(refundAmount << 128) | gasOverhead`
 * (`_checkGasRefund`: "refundAmount = gasRefund.overhead >> 128").
 */
function extractGasRefund(
    destinationSignature: Hex
): { token: Address, exchangeRate: bigint, overhead: bigint } | undefined {
    const ROUTING_PREFIX_LENGTH = 20
    const payload = slice(destinationSignature, ROUTING_PREFIX_LENGTH)
    if (payload.length < 4) return undefined // "0x" + at least 1 byte

    const mode = payload.slice(0, 4) // "0x" + 1 byte
    if (mode !== '0x05') return undefined // 0x04 (Permit2) carries no gas refund

    const readAddress = (from: number, to: number) => getAddress(slice(payload, from, to))
    const readUint = (from: number, to: number) => BigInt(slice(payload, from, to))

    const PROOF_OFFSET = 33
    const HEADER_LENGTH = 110 // 109-byte SessionEnableProof + 1-byte chain count
    const AUTHORIZATION_ENTRY_LENGTH = 40
    const OWNER_SIGNATURE_LENGTH = 65
    const chainCount = Number(readUint(PROOF_OFFSET + HEADER_LENGTH - 1, PROOF_OFFSET + HEADER_LENGTH))
    const sessionsOffset = PROOF_OFFSET + HEADER_LENGTH
    const proofEnd = sessionsOffset + chainCount * AUTHORIZATION_ENTRY_LENGTH + OWNER_SIGNATURE_LENGTH

    const token = readAddress(proofEnd + 32, proofEnd + 52)
    const exchangeRate = readUint(proofEnd + 52, proofEnd + 64)
    const refundAmount = readUint(proofEnd + 64, proofEnd + 76)
    const gasOverhead = readUint(proofEnd + 76, proofEnd + 82)
    const overhead = (refundAmount << 128n) | gasOverhead

    // A signature can carry an all-zero {token: 0x0, exchangeRate: 0, overhead: 0}
    // refund struct on every first-use commit, refund or not — the fields are
    // always structurally present in mode 0x05. The validator's own digest
    // treats that degenerate case as NO_GAS_REFUND_HASH (`_singleChainDigest`,
    // "gasRefund.token == 0 && ... ? NO_GAS_REFUND_HASH : keccak256(...)"), but
    // `EIP712Lib.hashGasRefund` has no such special case — it hashes whatever
    // it's given, zeroes included. So calling
    // `executeSinglechainOpsWithGasRefund_ERC20` with an all-zero struct
    // recomputes keccak256(TYPEHASH, 0, 0, 0), NOT NO_GAS_REFUND_HASH, and
    // mismatches the validator the same way calling the wrong function on a
    // REAL refund does. Treat "no refund" and "zero refund" as the same thing.
    if (token === zeroAddress && exchangeRate === 0n && overhead === 0n) return undefined
    return { token, exchangeRate, overhead }
}

/**
 * Returns setupOps calls only if the account is not yet deployed.
 * The SDK always includes setupOps in the signed metadata, but executing them
 * against an already-deployed account in the same mockFill batch causes reverts
 * because the intent executor's signature verification fails when combined with
 * factory deployment in a single transaction.
 */
async function getSetupCallsIfNeeded(
    executor: ReturnType<typeof chainContexts>[number],
    signedIntent: any,
    recipient: Address
): Promise<{ to: Address; callData: Hex }[]> {
    const setupOps = signedIntent.signedMetadata?.account?.setupOps
    if (!setupOps || setupOps.length === 0) return []

    // Check if account already has code deployed
    const isDeployed = await executor.isAccountDeployed(recipient)
    if (isDeployed) {
        console.log(`Account ${recipient} already deployed — skipping setupOps`)
        return []
    }

    return setupOps.map((op: any) => ({
        to: getAddress(op.to),
        callData: op.data as Hex
    }))
}

type TokenTransfer = {
    address: Address
    value: bigint
}

const IdAndAmount = z.tuple([BigIntSchema, BigIntSchema]).transform((v) => {
    return {
        address: pad(toHex(BigInt(v[0])), { size: 20 }),
        value: BigInt(v[1])
    }
})

const IdsAndAmounts = z.array(IdAndAmount)

function toTokenTransfers(elements: { mandate: { tokenOut: unknown } }[]): TokenTransfer[] {
    return elements.flatMap((element) => IdsAndAmounts.parse(element.mandate.tokenOut))
}

const DestinationOp = z.object({
    to: AddressSchema,
    data: VarHex
}).transform((v) => {
    return {
        to: v.to,
        callData: v.data
    }
})

const DestinationOps = z.array(DestinationOp)

function toDestinationOps(elements: { mandate: { destinationOps: unknown } }[]): { to: Address, callData: Hex }[] {
    return elements.flatMap((element) => {
        const destOps = element.mandate.destinationOps as unknown[] | { vt: string; ops: unknown[] } | undefined
        // SDK 1.1.0 sends destinationOps as { vt, ops } instead of array
        // Handle both old format (array) and new format ({ vt, ops })
        const opsArray = Array.isArray(destOps) ? destOps : ((destOps as { ops?: unknown[] })?.ops ?? [])
        return DestinationOps.parse(opsArray)
    })
}

function toDestinationOpsEncoded(elements: { mandate: { destinationOps: unknown } }[]): Hex {
    const allOps: { to: Address; value: bigint; data: Hex }[] = []
    let execType = 0x02  
    let sigMode = 0x01   

    for (const element of elements) {
        const destOps = element.mandate.destinationOps as { vt?: string; ops?: unknown[] } | undefined
        if (!destOps || !destOps.ops || destOps.ops.length === 0) {
            continue
        }

        // extract execType and sigMode from the first element's vt field
        if (allOps.length === 0 && destOps.vt) {
            const vt = destOps.vt as Hex
            execType = fromHex(slice(vt, 0, 1), 'number')
            sigMode = fromHex(slice(vt, 1, 2), 'number')
        }

        for (const op of destOps.ops) {
            const parsed = DestinationOpWithValue.parse(op)
            allOps.push(parsed)
        }
    }

    if (allOps.length === 0) {
        return '0x' as Hex
    }

    const encodedExecs = encodeAbiParameters(
        [
            {
                type: 'tuple[]',
                components: [
                    { type: 'address', name: 'to' },
                    { type: 'uint256', name: 'value' },
                    { type: 'bytes', name: 'data' },
                ],
            },
        ],
        [allOps]
    )

    return encodePacked(
        ['uint8', 'uint8', 'bytes'],
        [execType, sigMode, encodedExecs]
    )
}

const DestinationOpWithValue = z.object({
    to: AddressSchema,
    value: z.union([BigIntSchema, z.string()]).transform((v) => BigInt(v)),
    data: VarHex
}).transform((v) => ({
    to: v.to,
    value: v.value,
    data: v.data
}))

function isFakeSignature(signature: Hex): boolean {
    if (!signature || signature === '0x') return true
    const sigWithoutPrefix = signature.slice(2)
    return /^0+$/.test(sigWithoutPrefix)
}
