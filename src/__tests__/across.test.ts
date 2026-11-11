import { describe, expect, it } from "vitest";
import {
  Address,
  Chain,
  concat,
  encodeAbiParameters,
  hashDomain,
  hashTypedData,
  http,
  keccak256,
  toHex,
  zeroAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { arbitrumSepolia, baseSepolia, optimismSepolia, sepolia } from "viem/chains";
import { PERMIT2_ADDRESS } from "../abi/permit2";
import { ChainContext } from "../chains";
import {
  ACROSS_ARBITER,
  acrossLegs,
  MANDATE_WITNESS_TYPE_STRING,
  mandateWitness,
  parseAcrossElement,
} from "../across";

const USDC_BASE_SEPOLIA: Address = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_SEPOLIA: Address = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const HCA: Address = "0x00000000000000000000000000000000000000aa";

const element = parseAcrossElement({
  arbiter: ACROSS_ARBITER,
  chainId: "84532",
  idsAndAmounts: [[BigInt(USDC_BASE_SEPOLIA).toString(), "5000000"]],
  spendTokens: [],
  mandate: {
    recipient: HCA,
    tokenOut: [[BigInt(USDC_SEPOLIA).toString(), "5000000"]],
    destinationChainId: "11155111",
    fillDeadline: "1800000120",
    preClaimOps: { vt: `0x${"00".repeat(32)}`, ops: [] },
    destinationOps: {
      vt: `0x0201${"00".repeat(30)}`,
      ops: [{ to: HCA, value: "1", data: "0x1234" }],
    },
    qualifier: { settlementContext: {}, encodedVal: "0xff" },
    minGas: "0",
  },
});
const nonce = 42n;
const deadline = 1800000120n;

// What the wallet signs: getTypedData in @rhinestone/sdk 1.22 execution/permit2,
// copied verbatim so a drift on either side fails here, not on chain.
const walletTypedData = {
  domain: { name: "Permit2", chainId: 84532, verifyingContract: PERMIT2_ADDRESS },
  types: {
    TokenPermissions: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
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
    PermitBatchWitnessTransferFrom: [
      { name: "permitted", type: "TokenPermissions[]" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "mandate", type: "Mandate" },
    ],
  },
  primaryType: "PermitBatchWitnessTransferFrom",
  message: {
    permitted: [{ token: USDC_BASE_SEPOLIA, amount: 5000000n }],
    spender: ACROSS_ARBITER,
    nonce,
    deadline,
    mandate: {
      target: {
        recipient: HCA,
        tokenOut: [{ token: USDC_SEPOLIA, amount: 5000000n }],
        targetChain: 11155111n,
        fillExpiry: 1800000120n,
      },
      minGas: 0n,
      originOps: element.mandate.preClaimOps,
      destOps: element.mandate.destinationOps,
      q: keccak256("0xff"),
    },
  },
} as const;

// The digest Permit2's SignatureTransfer checks (PermitHash.hashWithWitness),
// built from what the fill passes it.
const permit2Digest = (witness: `0x${string}`, witnessTypeString: string) => {
  const typeHash = keccak256(
    toHex(
      "PermitBatchWitnessTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline," +
        witnessTypeString,
    ),
  );
  const tokenPermissionsHash = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
      [keccak256(toHex("TokenPermissions(address token,uint256 amount)")), USDC_BASE_SEPOLIA, 5000000n],
    ),
  );
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [typeHash, keccak256(concat([tokenPermissionsHash])), ACROSS_ARBITER, nonce, deadline, witness],
    ),
  );
  const domainSeparator = hashDomain({
    domain: walletTypedData.domain,
    types: { EIP712Domain: [
      { name: "name", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ] },
  });
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
};

// Offline contexts: acrossLegs only reads the token config, never the RPC.
const context = (chain: Chain, tokens: Record<string, Address>) =>
  new ChainContext(
    chain,
    privateKeyToAccount(generatePrivateKey()),
    {
      tokens: Object.fromEntries(
        Object.entries(tokens).map(([symbol, address]) => [symbol, { address, decimals: symbol == "ETH" ? 18 : 6 }]),
      ),
    },
    {} as never,
    http("http://127.0.0.1:1"),
  );

// USDC per chain, as in apps/manager/src/l2Sources.ts
const sepoliaContext = context(sepolia, { ETH: zeroAddress, USDC: USDC_SEPOLIA });
const l2Contexts = {
  base: context(baseSepolia, { ETH: zeroAddress, USDC: USDC_BASE_SEPOLIA }),
  arbitrum: context(arbitrumSepolia, { ETH: zeroAddress, USDC: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" }),
  optimism: context(optimismSepolia, { ETH: zeroAddress, USDC: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" }),
};

describe("acrossLegs", () => {
  it.each(Object.entries(l2Contexts))("pays Sepolia USDC from %s's USDC", (_, source) => {
    expect(acrossLegs(source, sepoliaContext, [{ tokenAddress: USDC_SEPOLIA, amount: "5000000" }])).toEqual([
      { token: source.getTokenAddress("USDC"), amount: 5000000n },
    ]);
  });

  it.each([
    ["a token the destination does not list", l2Contexts.base, HCA, "is not a known token on 11155111"],
    ["a symbol the source does not list", context(baseSepolia, { ETH: zeroAddress }), USDC_SEPOLIA, "USDC is not configured on source chain 84532"],
    ["native ETH", l2Contexts.base, zeroAddress, "ERC-20s only"],
  ])("refuses %s", (_, source, tokenAddress, message) => {
    expect(() => acrossLegs(source, sepoliaContext, [{ tokenAddress, amount: 1n }])).toThrow(message);
  });
});

describe("Across witness", () => {
  it("is what Permit2 recovers the wallet's signature against", () => {
    expect(permit2Digest(mandateWitness(element), MANDATE_WITNESS_TYPE_STRING)).toBe(
      hashTypedData(walletTypedData),
    );
  });
});
