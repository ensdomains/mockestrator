export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as const

export const permit2Abi = [
  {
    type: "function",
    name: "permitWitnessTransferFrom",
    inputs: [
      {
        name: "permit",
        type: "tuple",
        internalType: "struct ISignatureTransfer.PermitBatchTransferFrom",
        components: [
          {
            name: "permitted",
            type: "tuple[]",
            internalType: "struct ISignatureTransfer.TokenPermissions[]",
            components: [
              { name: "token", type: "address", internalType: "address" },
              { name: "amount", type: "uint256", internalType: "uint256" },
            ],
          },
          { name: "nonce", type: "uint256", internalType: "uint256" },
          { name: "deadline", type: "uint256", internalType: "uint256" },
        ],
      },
      {
        name: "transferDetails",
        type: "tuple[]",
        internalType: "struct ISignatureTransfer.SignatureTransferDetails[]",
        components: [
          { name: "to", type: "address", internalType: "address" },
          { name: "requestedAmount", type: "uint256", internalType: "uint256" },
        ],
      },
      { name: "owner", type: "address", internalType: "address" },
      { name: "witness", type: "bytes32", internalType: "bytes32" },
      { name: "witnessTypeString", type: "string", internalType: "string" },
      { name: "signature", type: "bytes", internalType: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const

// ERC-2612 permit, as Circle's FiatToken implements it.
export const erc2612Abi = [
  {
    type: "function",
    name: "permit",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "nonces",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "version",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
  },
] as const
