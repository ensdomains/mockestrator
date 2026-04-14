import { describe, it, expect } from "vitest";
import {
  Address,
  createPublicClient,
  createTestClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseEther,
  parseUnits,
  decodeEventLog,
  Hex,
} from "viem";
import { RhinestoneSDK } from "@rhinestone/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const API_BASE_URL = process.env.MOCKESTRATOR_URL ?? "http://localhost:4000";
const API_KEY = "test-api-key";

// Chain IDs from rpcs.json
const BASE_SEPOLIA_CHAIN_ID = 84532;
const SEPOLIA_CHAIN_ID = 11155111;
// USDC addresses from chains.json
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_SEPOLIA = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
// User and recipient addresses
const USER_ADDRESS = "0xDeaDbeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF";
const RECIPIENT_ADDRESS = "0x000000000000000000000000000000000000dEaD";
// RPC URLs from rpcs.json
const RPC_URLS: Record<number, string> = {
  [BASE_SEPOLIA_CHAIN_ID]: "http://localhost:30005",
  [SEPOLIA_CHAIN_ID]: "http://localhost:30006",
};

const headers = {
  "Content-Type": "application/json",
  "x-api-key": API_KEY,
};
async function apiCall<T>(
  method: string,
  path: string,
  body?: object
): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error ${response.status}: ${error}`);
  }

  return response.json();
}

// create signed intent from route response
function createSignedIntent(routeResponse: any) {
  return {
    ...routeResponse.intentOp,
    destinationSignature: "0x" + "00".repeat(65),
    originSignatures: ["0x" + "00".repeat(65)],
  };
}

describe("Mockestrator Intent Flow", () => {
  describe("Portfolio API", () => {
    it("should return portfolio for a user address", async () => {
      const userAddress = USER_ADDRESS;
      const response = await apiCall<any>(
        "GET",
        `/accounts/${userAddress}/portfolio`
      );

      expect(response).toHaveProperty("portfolio");
      expect(Array.isArray(response.portfolio)).toBe(true);

      const usdcEntry = response.portfolio.find(
        (p: any) => p.tokenName === "USDC"
      );
      expect(usdcEntry).toBeDefined();
      expect(usdcEntry.balance.unlocked).toBeGreaterThan(0);
    });

    it("should return ETH balance in portfolio", async () => {
      const response = await apiCall<any>(
        "GET",
        `/accounts/${USER_ADDRESS}/portfolio`
      );

      const ethEntry = response.portfolio.find(
        (p: any) => p.tokenName === "ETH"
      );
      expect(ethEntry).toBeDefined();
      expect(ethEntry.tokenDecimals).toBe(18);
      expect(ethEntry.balance.unlocked).toBeGreaterThan(0);
    });

    it("should return per-chain balances for each token", async () => {
      const response = await apiCall<any>(
        "GET",
        `/accounts/${USER_ADDRESS}/portfolio`
      );

      const usdcEntry = response.portfolio.find(
        (p: any) => p.tokenName === "USDC"
      );
      expect(usdcEntry).toBeDefined();
      expect(usdcEntry.tokenChainBalance.length).toBeGreaterThanOrEqual(2);

      const baseSepoliaBalance = usdcEntry.tokenChainBalance.find(
        (b: any) => b.chainId === BASE_SEPOLIA_CHAIN_ID
      );
      expect(baseSepoliaBalance).toBeDefined();
      expect(baseSepoliaBalance.tokenAddress.toLowerCase()).toBe(
        USDC_BASE_SEPOLIA.toLowerCase()
      );
      expect(baseSepoliaBalance.balance.unlocked).toBeGreaterThan(0);

      const sepoliaBalance = usdcEntry.tokenChainBalance.find(
        (b: any) => b.chainId === SEPOLIA_CHAIN_ID
      );
      expect(sepoliaBalance).toBeDefined();
      expect(sepoliaBalance.tokenAddress.toLowerCase()).toBe(
        USDC_SEPOLIA.toLowerCase()
      );
      expect(sepoliaBalance.balance.unlocked).toBeGreaterThan(0);
    });
  });

  describe("Intent Split API", () => {
    it("should return single intent with full amount for a single token", async () => {
      const response = await apiCall<any>("POST", "/intents/split", {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        tokens: { [USDC_BASE_SEPOLIA]: 1000000 },
      });

      expect(response).toHaveProperty("intents");
      expect(response.intents).toHaveLength(1);
      expect(response.intents[0][USDC_BASE_SEPOLIA]).toBe("1000000");
    });

    it("should return single intent with all tokens for multi-token request", async () => {
      const response = await apiCall<any>("POST", "/intents/split", {
        chainId: SEPOLIA_CHAIN_ID,
        tokens: {
          [USDC_SEPOLIA]: 5000000,
          "0x0000000000000000000000000000000000000000": 1000000000000000000,
        },
      });

      expect(response.intents).toHaveLength(1);
      expect(response.intents[0][USDC_SEPOLIA]).toBe("5000000");
      expect(
        response.intents[0]["0x0000000000000000000000000000000000000000"]
      ).toBe("1000000000000000000");
    });

    it("should return empty intents for empty tokens", async () => {
      const response = await apiCall<any>("POST", "/intents/split", {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        tokens: {},
      });

      expect(response.intents).toHaveLength(0);
    });
  });

  describe("Validation errors", () => {
    it("should return 400 for route request with missing required fields", async () => {
      const response = await fetch(`${API_BASE_URL}/intents/route`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toHaveProperty("error");
    });

    it("should return 400 for route request with missing tokenRequests", async () => {
      const response = await fetch(`${API_BASE_URL}/intents/route`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          destinationChainId: BASE_SEPOLIA_CHAIN_ID,
          account: { address: USER_ADDRESS },
        }),
      });

      expect(response.status).toBe(400);
    });

    it("should return 400 for split request with missing chainId", async () => {
      const response = await fetch(`${API_BASE_URL}/intents/split`, {
        method: "POST",
        headers,
        body: JSON.stringify({ tokens: { [USDC_BASE_SEPOLIA]: 1000000 } }),
      });

      expect(response.status).toBe(400);
    });

    it("should return 404 for non-existent intent operation", async () => {
      const response = await fetch(
        `${API_BASE_URL}/intent-operation/9999999999999999999`,
        { method: "GET", headers }
      );

      expect(response.status).toBe(404);
    });
  });

  describe("Same-chain Intent Flow", () => {
    it("should route and execute same-chain USDC transfer intent", async () => {
      const userAddress = USER_ADDRESS;
      const transferAmount = parseUnits("100", 6); // 100 USDC

      // route intent
      const routePayload = {
        destinationChainId: BASE_SEPOLIA_CHAIN_ID,
        tokenRequests: [
          {
            tokenAddress: USDC_BASE_SEPOLIA,
            amount: transferAmount.toString(),
          },
        ],
        account: {
          address: userAddress,
        },
        accountAccessList: {
          chainIds: [BASE_SEPOLIA_CHAIN_ID],
        },
      };

      const routeResponse = await apiCall<any>(
        "POST",
        "/intents/route",
        routePayload
      );

      expect(routeResponse).toHaveProperty("intentOp");
      expect(routeResponse).toHaveProperty("intentCost");
      expect(routeResponse.intentCost.hasFulfilledAll).toBe(true);
      expect(
        routeResponse.intentOp.elements[0].mandate.qualifier.settlementContext
          .settlementLayer
      ).toBe("INTENT_EXECUTOR");

      // submit signed intent
      const signedIntent = createSignedIntent(routeResponse);

      const submitPayload = {
        signedIntentOp: signedIntent,
      };

      const submitResponse = await apiCall<any>(
        "POST",
        "/intent-operations",
        submitPayload
      );

      expect(submitResponse).toHaveProperty("result");
      expect(submitResponse.result.status).toBe("PENDING");
      const intentId = submitResponse.result.id;

      // check intent status
      const statusResponse = await apiCall<any>(
        "GET",
        `/intent-operation/${intentId}`
      );

      expect(statusResponse.status).toBe("COMPLETED");
      expect(statusResponse.destinationChainId).toBe(
        BASE_SEPOLIA_CHAIN_ID.toString()
      );
      expect(statusResponse.fillTransactionHash).toBeDefined();

      // verify the transaction receipt has Transfer event
      const publicClient = createPublicClient({
        transport: http(RPC_URLS[BASE_SEPOLIA_CHAIN_ID]),
      });

      const receipt = await publicClient.getTransactionReceipt({
        hash: statusResponse.fillTransactionHash as Hex,
      });

      expect(receipt.status).toBe("success");

      // find Transfer event for USDC
      const transferLogs = receipt.logs.filter(
        (log) => log.address.toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase()
      );

      expect(transferLogs.length).toBeGreaterThan(0);

      // decode and verify Transfer event
      const transferLog = transferLogs[0];
      const decodedLog = decodeEventLog({
        abi: erc20Abi,
        data: transferLog.data,
        topics: transferLog.topics,
      });

      expect(decodedLog.eventName).toBe("Transfer");
      expect((decodedLog.args as any).to.toLowerCase()).toBe(
        userAddress.toLowerCase()
      );
      expect((decodedLog.args as any).value).toBe(transferAmount);
    });
  });

  describe("Cross-chain Intent Flow", () => {
    it("should route and execute cross-chain USDC transfer (Base Sepolia → Sepolia)", async () => {
      const userAddress = USER_ADDRESS;
      const transferAmount = parseUnits("50", 6);

      // route intent: source on base sepolia, destination on sepolia
      const routePayload = {
        destinationChainId: SEPOLIA_CHAIN_ID,
        tokenRequests: [
          {
            tokenAddress: USDC_SEPOLIA,
            amount: transferAmount.toString(),
          },
        ],
        account: {
          address: userAddress,
        },
        accountAccessList: {
          chainIds: [BASE_SEPOLIA_CHAIN_ID],
        },
      };

      const routeResponse = await apiCall<any>(
        "POST",
        "/intents/route",
        routePayload
      );

      expect(routeResponse).toHaveProperty("intentOp");
      expect(
        routeResponse.intentOp.elements[0].mandate.qualifier.settlementContext
          .settlementLayer
      ).toBe("ACROSS");

      // submit signed intent
      const signedIntent = createSignedIntent(routeResponse);
      const submitResponse = await apiCall<any>("POST", "/intent-operations", {
        signedIntentOp: signedIntent,
      });

      expect(submitResponse.result.status).toBe("PENDING");
      const intentId = submitResponse.result.id;

      // check status
      const statusResponse = await apiCall<any>(
        "GET",
        `/intent-operation/${intentId}`
      );

      expect(statusResponse.status).toBe("COMPLETED");
      expect(statusResponse.destinationChainId).toBe(
        SEPOLIA_CHAIN_ID.toString()
      );
      expect(statusResponse.fillTransactionHash).toBeDefined();

      // verify transaction on destination chain (sepolia)
      const publicClient = createPublicClient({
        transport: http(RPC_URLS[SEPOLIA_CHAIN_ID]),
      });

      const receipt = await publicClient.getTransactionReceipt({
        hash: statusResponse.fillTransactionHash as Hex,
      });

      expect(receipt.status).toBe("success");

      // find Transfer event for usdc on sepolia
      const transferLogs = receipt.logs.filter(
        (log) => log.address.toLowerCase() === USDC_SEPOLIA.toLowerCase()
      );

      expect(transferLogs.length).toBeGreaterThan(0);

      const decodedLog = decodeEventLog({
        abi: erc20Abi,
        data: transferLogs[0].data,
        topics: transferLogs[0].topics,
      });

      expect(decodedLog.eventName).toBe("Transfer");
      expect((decodedLog.args as any).to.toLowerCase()).toBe(
        userAddress.toLowerCase()
      );
    });
  });

  describe("Intent with Destination Operations", () => {
    // SDK ↔ on-chain IntentExecutor signature hash mismatch on forked testnet
    it.skip("should execute destination ops that perform ERC-20 transfer via IntentExecutor", async () => {
      const finalRecipient = RECIPIENT_ADDRESS;
      const transferAmount = parseUnits("25", 6);
      const destOpsAmount = parseUnits("10", 6);

      const owner = privateKeyToAccount(generatePrivateKey());
      const sdk = new RhinestoneSDK({
        apiKey: API_KEY,
        endpointUrl: API_BASE_URL,
      });

      const rhinestoneAccount = await sdk.createAccount({
        owners: {
          type: "ecdsa",
          accounts: [owner],
        },
        account: {
          type: "nexus",
        },
      });

      const accountAddress = rhinestoneAccount.getAddress();

      const testClient = createTestClient({
        chain: baseSepolia,
        mode: "anvil",
        transport: http(RPC_URLS[BASE_SEPOLIA_CHAIN_ID]),
      });

      await testClient.setBalance({
        address: accountAddress,
        value: parseEther("10"),
      });

      const publicClient = createPublicClient({
        transport: http(RPC_URLS[BASE_SEPOLIA_CHAIN_ID]),
      });

      const accountBalanceBefore = await publicClient.readContract({
        address: USDC_BASE_SEPOLIA as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [accountAddress],
      });
      const finalBalanceBefore = await publicClient.readContract({
        address: USDC_BASE_SEPOLIA as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [finalRecipient as Address],
      });

      // encode ERC-20 transfer call for destination ops
      const transferCalldata = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [finalRecipient as Address, destOpsAmount],
      });

      const transaction = {
        targetChain: baseSepolia,
        tokenRequests: [
          {
            address: USDC_BASE_SEPOLIA as Address,
            amount: transferAmount,
          },
        ],
        calls: [
          {
            to: USDC_BASE_SEPOLIA as Address,
            data: transferCalldata,
          },
        ],
      };

      const preparedTx = await rhinestoneAccount.prepareTransaction(
        transaction
      );
      const signedTx = await rhinestoneAccount.signTransaction(preparedTx);
      const result = await rhinestoneAccount.submitTransaction(signedTx);

      expect(result.type).toBe("intent");

      await new Promise((resolve) => setTimeout(resolve, 1000));

      const statusResponse = await apiCall<any>(
        "GET",
        `/intent-operation/${result.id}`
      );

      expect(statusResponse.status).toBe("COMPLETED");
      expect(statusResponse.fillTransactionHash).toBeDefined();

      // verify transaction receipt
      const receipt = await publicClient.getTransactionReceipt({
        hash: statusResponse.fillTransactionHash as Hex,
      });

      expect(receipt.status).toBe("success");

      const transferLogs = receipt.logs.filter(
        (log) => log.address.toLowerCase() === USDC_BASE_SEPOLIA.toLowerCase()
      );

      const decodedTransfers = transferLogs
        .map((log) => {
          try {
            return decodeEventLog({
              abi: erc20Abi,
              data: log.data,
              topics: log.topics,
            });
          } catch {
            return null;
          }
        })
        .filter(Boolean);

      // verify we have transfers to both recipients
      const transferToUser = decodedTransfers.find(
        (t: any) => t?.args?.to?.toLowerCase() === accountAddress.toLowerCase()
      );
      const transferToFinal = decodedTransfers.find(
        (t: any) => t?.args?.to?.toLowerCase() === finalRecipient.toLowerCase()
      );

      expect(transferToUser).toBeDefined();
      expect(transferToFinal).toBeDefined();
      expect((transferToFinal as any).args.from.toLowerCase()).toBe(
        accountAddress.toLowerCase()
      );
      expect((transferToFinal as any).args.value).toBe(destOpsAmount);

      const accountBalanceAfter = await publicClient.readContract({
        address: USDC_BASE_SEPOLIA as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [accountAddress],
      });
      const finalBalanceAfter = await publicClient.readContract({
        address: USDC_BASE_SEPOLIA as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [finalRecipient as Address],
      });

      expect(accountBalanceAfter - accountBalanceBefore).toBe(
        transferAmount - destOpsAmount
      );
      expect(finalBalanceAfter - finalBalanceBefore).toBe(destOpsAmount);

      console.log("Destination ops executed via IntentExecutor");
      console.log(`   - Account: ${accountAddress}`);
      console.log(`   - User received: ${transferAmount - destOpsAmount}`);
      console.log(`   - Destination recipient received: ${destOpsAmount}`);
    });
  });
});
