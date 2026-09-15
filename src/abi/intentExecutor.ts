export const intentExecutorAbi = [
  {
    type: "function",
    name: "executeSinglechainOps",
    inputs: [
      {
        name: "signedOps",
        type: "tuple",
        internalType: "struct IStandaloneIntentExecutor.SingleChainOps",
        components: [
          { name: "account", type: "address", internalType: "address" },
          { name: "nonce", type: "uint256", internalType: "uint256" },
          {
            name: "ops",
            type: "tuple",
            internalType: "struct Types.Operation",
            components: [
              { name: "data", type: "bytes", internalType: "bytes" },
            ],
          },
          { name: "signature", type: "bytes", internalType: "bytes" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "executeSinglechainOpsWithGasRefund_ERC20",
    inputs: [
      {
        name: "signedOps",
        type: "tuple",
        internalType: "struct IStandaloneIntentExecutor.SingleChainOps",
        components: [
          { name: "account", type: "address", internalType: "address" },
          { name: "nonce", type: "uint256", internalType: "uint256" },
          {
            name: "ops",
            type: "tuple",
            internalType: "struct Types.Operation",
            components: [
              { name: "data", type: "bytes", internalType: "bytes" },
            ],
          },
          { name: "signature", type: "bytes", internalType: "bytes" },
        ],
      },
      {
        name: "gasRefund",
        type: "tuple",
        internalType: "struct IStandaloneIntentExecutor.GasRefund",
        components: [
          { name: "token", type: "address", internalType: "address" },
          { name: "exchangeRate", type: "uint256", internalType: "uint256" },
          { name: "overhead", type: "uint256", internalType: "uint256" },
        ],
      },
      { name: "gasRefundRecipient", type: "address", internalType: "address" },
    ],
    outputs: [
      { name: "account", type: "address", internalType: "address" },
      { name: "nonce", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "isInitialized",
    inputs: [
      { name: "smartAccount", type: "address", internalType: "address" },
    ],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isStandaloneIntentNonceConsumed",
    inputs: [
      { name: "nonce", type: "uint256", internalType: "uint256" },
      { name: "account", type: "address", internalType: "address" },
    ],
    outputs: [{ name: "used", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  { type: "error", name: "InvalidStandaloneIntentSignature", inputs: [] },
  {
    type: "error",
    name: "NotInitialized",
    inputs: [
      { name: "smartAccount", type: "address", internalType: "address" },
    ],
  },
] as const;

// prod address, not using dev address
export const INTENT_EXECUTOR_ADDRESS =
  "0x00000000005aD9ce1f5035FD62CA96CEf16AdAAF" as const;
