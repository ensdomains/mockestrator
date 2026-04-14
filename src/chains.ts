import { readFileSync } from "fs";
import { Account, Address, Chain, createTestClient, createWalletClient, encodeAbiParameters, encodeFunctionData, encodePacked, erc20Abi, getAddress, Hash, Hex, http, keccak256, multicall3Abi, NonceTooLowError, numberToHex, pad, publicActions, stringToHex, toHex, Transport, zeroAddress } from "viem";
import z, { symbol, ZodSchema } from "zod";
import { privateKeyToAccount } from 'viem/accounts'
import { fakeRouterAbi } from "./abi/fakeRouter";
import { intentExecutorAbi, INTENT_EXECUTOR_ADDRESS } from "./abi/intentExecutor";
import * as chains from "viem/chains"

type TokenSymbol = string

const viemChains: Record<number, Chain> = Object.fromEntries(Object.values(chains).map(c => [c.id, c]));

export type Balance = {
    symbol: TokenSymbol
    token: Address,
    amount: BigInt,
    decimals: number,
    chainId: number,
}

export class ChainContext {

    private walletClient

    private testClient

    private tokens: Record<Address, {
        decimals: number;
        balanceSlot?: number;
        approvalSlot?: number;
    }> = {}

    private tokenSymbols: TokenSymbol[] = []

    constructor(private chain: Chain, account: Account, private chainConfig: ChainConfig, private fundingConfig: Config, transport: Transport) {
        this.walletClient = createWalletClient({
            account,
            transport,
            chain
        }).extend(publicActions)

        for (const [symbol, tokenConfig] of Object.entries(chainConfig.tokens)) {
            this.tokens[tokenConfig.address] = tokenConfig
            this.tokenSymbols.push(symbol)
        }

        this.testClient = createTestClient({
            chain: this.walletClient.chain,
            mode: "anvil",
            transport,
        });
    }

    get chainId(): number {
        return this.chain.id
    }

    get chainName(): string {
        return this.chain.name
    }

    get isTestnet(): boolean {
        return (this.chain as any).testnet ?? true
    }

    tokenDecimals(symbol: TokenSymbol): number | undefined {
        const addr = this.maybeAddress(symbol)
        return addr ? this.tokens[addr]?.decimals : undefined
    }

    maybeAddress(symbol: TokenSymbol): Address | undefined {
        return this.chainConfig.tokens[symbol]?.address
    }

    getTokenAddress(symbol: TokenSymbol): Address {
        let address = this.maybeAddress(symbol)
        if (!address) {
            throw new Error(`No token address for ${symbol} on ${this.chain}`)
        }
        return address
    }

    supportedTokens(): TokenSymbol[] {
        return this.tokenSymbols
    }

    public async balanceOf(address: Address, tokenSymbols: TokenSymbol[]): Promise<Balance[]> {

        const tokens = tokenSymbols.map((symbol) => {
            const tokenAddress = this.getTokenAddress(symbol)
            return {
                symbol,
                decimals: this.tokens[tokenAddress].decimals,
                token: tokenAddress,
                chainId: this.chain.id
            }
        })

        const nativeCallsPromises = tokens.filter((token) => token.symbol == 'ETH').map(async (token) => {

            const amount = await this.walletClient.getBalance({ address })
            return {
                ...token,
                amount,
            }
        })

        const erc20Tokens = tokens.filter((token) => token.symbol != 'ETH')

        const erc20Calls = erc20Tokens.map((token) => {
            return {
                address: token.token,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [address]
            }
        })

        const erc20CallsPromise = this.walletClient.multicall({ contracts: erc20Calls }).then((res) => res.map((v) => v.result ?? 0n))

        const [erc20Balances, ...nativeBalances] = await Promise.all([erc20CallsPromise, ...nativeCallsPromises])


        return erc20Tokens.map((token, i) => { return { ...token, amount: BigInt(erc20Balances[i]) } }).concat(nativeBalances)
    }

    public transferFrom(to: Address, amount: bigint): Hex {
        return encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transferFrom',
            args: [this.walletClient.account.address, to, amount]
        })
    }

    public transfer(to: Address, amount: bigint): Hex {
        return encodeFunctionData({
            abi: erc20Abi,
            functionName: 'transfer',
            args: [to, amount]
        })
    }

    public multicall(calls: { to: Address, callData: Hex }[]): { to: Address, callData: Hex } {

        const multicallContract = this.walletClient.chain.contracts?.multicall3
        if (!multicallContract) {
            throw new Error(`Chain ${this.walletClient.chain.name} doesnt support multicall contract`)
        }

        const data = encodeFunctionData({
            abi: multicall3Abi,
            functionName: 'aggregate3',
            args: [calls.map((call) => { return { target: call.to, allowFailure: false, callData: call.callData } })]
        })

        return {
            to: multicallContract.address,
            callData: data
        }
    }

    public async execute(execution: { to: Address, callData: Hex, value: bigint }): Promise<Hash> {
        try {
            const receipt = await this.walletClient.sendTransactionSync({
                to: execution.to,
                value: execution.value,
                data: execution.callData,
            })
            if (receipt.status == 'reverted') {
                throw new Error(`Transaction ${receipt.transactionHash} reverted`)
            }
            return receipt.transactionHash
        } catch (error: any) {
            const isNonceError = error instanceof NonceTooLowError || error?.cause instanceof NonceTooLowError
            if (isNonceError) {
                const nextNonce = await this.walletClient.getTransactionCount({ address: this.walletClient.account.address })
                const receipt = await this.walletClient.sendTransactionSync({
                    to: execution.to,
                    value: execution.value,
                    data: execution.callData,
                    nonce: nextNonce,
                })
                if (receipt.status == 'reverted') {
                    throw new Error(`Transaction ${receipt.transactionHash} reverted`)
                }
                return receipt.transactionHash
            }
            throw error
        }
    }

    public async setupAccount(config: Config) {
        for (const [addressStr, tokens] of Object.entries(config.funding)) {
            const address = getAddress(addressStr)
            for (const [symbol, value] of Object.entries(tokens)) {
                await this.fundAccount(address, symbol as TokenSymbol, value)
            }
        }

        for (const [ownerStr, approvals] of Object.entries(config.erc20approvals ?? {})) {
            const owner = getAddress(ownerStr)
            for (const [spenderStr, tokens] of Object.entries(approvals)) {
                const spender = getAddress(spenderStr)
                for (const [symbol, value] of Object.entries(tokens)) {
                    await this.approveSpending(owner, spender, symbol as TokenSymbol, value)
                }
            }
        }
    }

    public async fundAccount(account: Address, token: TokenSymbol, value: bigint) {
        const tokenAddress = this.maybeAddress(token)
        if (!tokenAddress) {
            console.log(`${token} token is not defined for ${this.chain.name} - cannot fund`)
            return
        }

        if (tokenAddress == zeroAddress) {
            console.log(`${this.walletClient.chain.name}: Native balance for ${account} -> ${value}]`)
            await this.testClient.setBalance({
                address: account,
                value,
            })
        } else {
            const balanceSlot = this.tokens[tokenAddress].balanceSlot
            if (balanceSlot == undefined) {
                throw new Error(`${token} at ${tokenAddress} config has undefined balance slot`)
            }
            const slot = keccak256(
                encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account, BigInt(balanceSlot)]),
            );
            console.log(`${this.walletClient.chain.name}: Erc20 balance for ${account} on ${token} ( ${tokenAddress}) -> ${value}]`)
            await this.testClient.setStorageAt({
                address: tokenAddress,
                index: slot,
                value: pad(numberToHex(value)),
            })
        }
    }
    public async approveSpending(owner: Address, spender: Address, token: TokenSymbol, value: bigint) {
        const tokenAddress = this.maybeAddress(token)
        if (!tokenAddress) {
            console.log(`${token} token is not defined for ${this.chain.name} - cannot approve spending`)
            return
        }
        if (tokenAddress == zeroAddress) {
            // skip natives
        } else {
            const approvalSlot = this.tokens[tokenAddress].approvalSlot
            if (!approvalSlot) {
                throw new Error(`${token} at ${tokenAddress} config has undefined approval slot`)
            }

            const inner = keccak256(encodePacked(["bytes32", "bytes32"], [pad(owner), pad(toHex(approvalSlot))]));
            const slot = keccak256(encodePacked(["bytes32", "bytes32"], [pad(spender), inner]))
            console.log(`${this.walletClient.chain.name}: Erc20 approval from ${owner}, to ${spender} on ${token} ( ${tokenAddress}) -> ${value}]`)
            await this.testClient.setStorageAt({
                address: tokenAddress,
                index: slot,
                value: pad(numberToHex(value)),
            })
        }
    }

    public async overrideCode(address: Address, code: Hex) {
        await this.testClient.setCode({
            address,
            bytecode: code
        })
    }

    public async callFakeRouter(calls: { to: Address, callData: Hex }[]): Promise<{ to: Address, callData: Hex }> {
        const encoded = encodeFunctionData({
            abi: fakeRouterAbi,
            functionName: 'mockFill',
            args: [calls.map((call) => { return { target: call.to, callData: call.callData } })]
        })

        return {
            to: this.fundingConfig.routerAddress as Address,
            callData: encoded
        }
    }

    public intentExecutorCall(
        account: Address,
        nonce: bigint,
        opsData: Hex,
        signature: Hex
    ): { to: Address; callData: Hex } {
        const callData = encodeFunctionData({
            abi: intentExecutorAbi,
            functionName: 'executeSinglechainOps',
            args: [{
                account,
                nonce,
                ops: { data: opsData },
                signature,
            }],
        })

        return {
            to: INTENT_EXECUTOR_ADDRESS,
            callData,
        }
    }

    public async executeViaIntentExecutor(
        account: Address,
        nonce: bigint,
        opsData: Hex,
        signature: Hex
    ): Promise<Hash> {
        const { to, callData } = this.intentExecutorCall(account, nonce, opsData, signature)

        return this.execute({
            to,
            callData,
            value: 0n,
        })
    }
}

type ChainContexts = { [key: number]: ChainContext }

export const fixedHex = (numbytes: number) => {
    return z.string().regex(
        new RegExp(`^0x[a-fA-F0-9]{${numbytes * 2}}$`),
        { message: `Expected 0x-prefixed hex string of ${numbytes} bytes` }
    ).transform((v) => v as Hex)
}

export const VarHex = z.string().regex(
    new RegExp(/^0x[a-fA-F0-9]+$/),
    { message: `Expected variable length 0x-prefixed hex string` }
).transform((v) => v as Hex)


export const AddressSchema = fixedHex(20).transform((v) => v as Address)

export const BigIntSchema = z.coerce.bigint()

const RpcSchema = z.record(z.string(), z.object({
    rpc: z.string(),
}))
type RpcConfig = z.infer<typeof RpcSchema>

const ConfigSchema = z.object({
    relayerKey: fixedHex(32),
    relayerAddress: AddressSchema,
    funding: z.record(AddressSchema, z.record(z.string(), BigIntSchema)),
    routerAddress: AddressSchema,
    erc20approvals: z.record(AddressSchema, z.record(AddressSchema, z.record(z.string(), BigIntSchema))).optional()

})
type Config = z.infer<typeof ConfigSchema>


const CodeSchema = z.record(AddressSchema, VarHex)
type CodeOverrides = z.infer<typeof CodeSchema>

const ChainConfigSchema = z.object({
    multicall3: AddressSchema.optional(),
    tokens: z.record(z.string(), z.object({
        address: AddressSchema,
        decimals: z.number(),
        approvalSlot: z.number().optional(),
        balanceSlot: z.number().optional()
    }))
})
type ChainConfig = z.infer<typeof ChainConfigSchema>

const ChainConfigsSchema = z.record(z.string(), ChainConfigSchema)
type ChainConfigs = z.infer<typeof ChainConfigsSchema>


async function loadChainContexts(): Promise<ChainContexts> {
    const rpcs: RpcConfig = loadJsonWithSchema('rpcs.json', RpcSchema)
    const config: Config = loadJsonWithSchema('config.json', ConfigSchema)
    const codeOverrides: CodeOverrides = loadJsonWithSchema('code.json', CodeSchema)
    const chainConfigs: ChainConfigs = loadJsonWithSchema('chains.json', ChainConfigsSchema)

    const account = privateKeyToAccount(config.relayerKey)
    const accountAddress = config.relayerAddress
    if (account.address != accountAddress) {
        throw new Error(`Invalid configuration: expected relayer address: ${accountAddress} doesn't match derived from key: ${account.address}`)
    }

    let res: ChainContexts = {}

    for (const [key, rpcConfig] of Object.entries(rpcs)) {
        const chainId = parseInt(key);

        const chainEntry = chainConfigs[key]
        if (!chainEntry) {
            throw new Error(`Unsupported chain ${key} in rpcs file`)
        }

        let chain = viemChains[chainId]
        if (!chain) {

            const maybeNativeToken = Object.entries(chainEntry.tokens).find(([_, token]) => token.address == zeroAddress)
            if (!maybeNativeToken) {
                throw new Error(`No native token defined for custom chain ${chainId}`)
            }

            const [symbol, token] = maybeNativeToken
            chain = {
                id: chainId,
                name: `Custom ${chainId}`,
                nativeCurrency: {
                    name: symbol,
                    symbol: symbol,
                    decimals: token.decimals
                },
                rpcUrls: {
                    default: { http: ["http://127.0.0.1:8545"] },
                },
                contracts: {
                    multicall3: chainEntry.multicall3 ? {
                        address: chainEntry.multicall3
                    } : undefined
                }
            }
        }

        const chainContext = new ChainContext(chain, account, chainEntry, config, http(rpcConfig.rpc))

        await chainContext.setupAccount(config)

        for (const [addressStr, code] of Object.entries(codeOverrides)) {
            await chainContext.overrideCode(getAddress(addressStr), code)
        }

        res[chainId] = chainContext
    }


    return res
}

let chainContextMap: ChainContexts | undefined

export const initContexts = async () => {
    chainContextMap = await loadChainContexts()
}

export const chainContexts = (): ChainContexts => {
    if (!chainContextMap) {
        throw new Error(`Chain contexts not initialized - please call initContexts()`)
    }
    return chainContextMap!
}

export function chainContext(chain: number): ChainContext {
    const chainContext = chainContexts()[chain]
    if (!chainContext) {
        throw new Error('Unsupported chain context ${chain}')
    }
    return chainContext
}

function loadJsonWithSchema<T extends ZodSchema>(
    path: string,
    schema: T
): z.infer<T> {
    const raw = readFileSync(path, "utf-8");
    const json = JSON.parse(raw);
    const result = schema.parse(json);
    return result;
}