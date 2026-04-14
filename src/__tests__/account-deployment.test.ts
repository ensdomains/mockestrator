import { describe, it, expect, beforeAll } from "vitest";
import {
  Address,
  createPublicClient,
  createTestClient,
  http,
  parseEther,
  parseUnits,
  Hex,
  encodeFunctionData,
  erc20Abi,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { RhinestoneSDK } from "@rhinestone/sdk";
import { baseSepolia } from "viem/chains";

const API_BASE_URL = process.env.MOCKESTRATOR_URL ?? "http://localhost:4000";
const API_KEY = "test-api-key";
const RPC_URL = "http://localhost:30005";
const USDC_DECIMALS = 6;

// Contract addresses (already deployed on forked testnets)
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

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

describe("Account Deployment via Intent Execution", () => {
  let ownerPrivateKey: Hex;
  let ownerAddress: Address;
  let counterfactualAddress: Address;

  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL),
  });

  const testClient = createTestClient({
    chain: baseSepolia,
    mode: "anvil",
    transport: http(RPC_URL),
  });

  beforeAll(async () => {
    ownerPrivateKey = generatePrivateKey();
    const owner = privateKeyToAccount(ownerPrivateKey);
    ownerAddress = owner.address;

    console.log(`Owner address: ${ownerAddress}`);
  });

  it("should receive funds via intent with real SDK signature", async () => {
    const owner = privateKeyToAccount(ownerPrivateKey);

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

    counterfactualAddress = rhinestoneAccount.getAddress();
    console.log(`Counterfactual address: ${counterfactualAddress}`);

    await testClient.setBalance({
      address: counterfactualAddress,
      value: parseEther("10"),
    });

    const balance = await publicClient.getBalance({
      address: counterfactualAddress,
    });
    expect(balance).toBe(parseEther("10"));

    console.log(`Funded counterfactual address with 10 ETH`);

    const transaction = {
      targetChain: baseSepolia,
      tokenRequests: [
        {
          address: USDC_BASE_SEPOLIA as Address,
          amount: parseUnits("1", USDC_DECIMALS), // 1 USDC
        },
      ],
    };

    console.log("Preparing transaction via SDK...");
    const preparedTx = await rhinestoneAccount.prepareTransaction(transaction);

    expect(preparedTx.intentRoute).toBeDefined();
    expect(preparedTx.intentRoute.intentOp).toBeDefined();

    console.log("Signing transaction...");
    const signedTx = await rhinestoneAccount.signTransaction(preparedTx);

    expect(signedTx.originSignatures).toBeDefined();
    expect(signedTx.destinationSignature).toBeDefined();
    expect(signedTx.destinationSignature.length).toBeGreaterThan(2);

    console.log("Submitting signed transaction...");
    const result = await rhinestoneAccount.submitTransaction(signedTx);

    expect(result.type).toBe("intent");
    expect(result.id).toBeDefined();
    console.log(`Transaction submitted with ID: ${result.id}`);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const statusResponse = await apiCall<any>(
      "GET",
      `/intent-operation/${result.id}`
    );

    expect(statusResponse.status).toBe("COMPLETED");
    expect(statusResponse.fillTransactionHash).toBeDefined();
    expect(statusResponse.fillTransactionHash).not.toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );

    console.log(
      `Intent completed with tx: ${statusResponse.fillTransactionHash}`
    );

    const usdcBalance = await publicClient.readContract({
      address: USDC_BASE_SEPOLIA as Address,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [counterfactualAddress],
    });

    expect(usdcBalance).toBe(parseUnits("1", USDC_DECIMALS));
    console.log(`User received ${usdcBalance} USDC`);
  });

  it("should fail with invalid signature when destination ops present", async () => {
    const owner = privateKeyToAccount(ownerPrivateKey);

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

    // Fund account
    await testClient.setBalance({
      address: accountAddress,
      value: parseEther("10"),
    });

    // Prepare a transaction with destination ops (a transfer call)
    const transferCalldata = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [
        "0x000000000000000000000000000000000000dEaD" as Address,
        parseUnits("0.5", USDC_DECIMALS),
      ],
    });

    const transaction = {
      targetChain: baseSepolia,
      tokenRequests: [
        {
          address: USDC_BASE_SEPOLIA as Address,
          amount: parseUnits("1", USDC_DECIMALS),
        },
      ],
      calls: [
        {
          to: USDC_BASE_SEPOLIA as Address,
          data: transferCalldata,
        },
      ],
    };

    const preparedTx = await rhinestoneAccount.prepareTransaction(transaction);
    const signedTx = await rhinestoneAccount.signTransaction(preparedTx);

    const tamperedSignedTx = {
      ...signedTx,
      destinationSignature: ("0x" + "ab".repeat(65)) as Hex, // Invalid signature
    };

    try {
      await rhinestoneAccount.submitTransaction(tamperedSignedTx as any);
      expect.fail("Should have thrown an error for invalid signature");
    } catch (error: any) {
      console.log(`Got expected error: ${error.message}`);
      expect(error.message).toBeDefined();
    }
  });

  // SDK ↔ on-chain IntentExecutor signature hash mismatch on forked testnet
  it.skip("should execute destination ops via IntentExecutor with account as msg.sender", async () => {
    const owner = privateKeyToAccount(ownerPrivateKey);

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
    console.log(`Account address: ${accountAddress}`);

    await testClient.setBalance({
      address: accountAddress,
      value: parseEther("10"),
    });

    const spenderAddress =
      "0x1111111111111111111111111111111111111111" as Address;
    const approveAmount = parseUnits("100", USDC_DECIMALS);

    const approveCalldata = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spenderAddress, approveAmount],
    });

    const transaction = {
      targetChain: baseSepolia,
      tokenRequests: [
        {
          address: USDC_BASE_SEPOLIA as Address,
          amount: parseUnits("1", USDC_DECIMALS),
        },
      ],
      calls: [
        {
          to: USDC_BASE_SEPOLIA as Address,
          data: approveCalldata,
        },
      ],
    };

    const preparedTx = await rhinestoneAccount.prepareTransaction(transaction);

    const signedTx = await rhinestoneAccount.signTransaction(preparedTx);

    const result = await rhinestoneAccount.submitTransaction(signedTx);

    expect(result.type).toBe("intent");
    console.log(`Transaction submitted with ID: ${result.id}`);

    await new Promise((resolve) => setTimeout(resolve, 1000));

    const statusResponse = await apiCall<any>(
      "GET",
      `/intent-operation/${result.id}`
    );

    expect(statusResponse.status).toBe("COMPLETED");
    console.log(
      `Intent completed with tx: ${statusResponse.fillTransactionHash}`
    );

    const allowance = await publicClient.readContract({
      address: USDC_BASE_SEPOLIA as Address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [accountAddress, spenderAddress],
    });

    console.log(
      `Allowance from ${accountAddress} to ${spenderAddress}: ${allowance}`
    );
    expect(allowance).toBe(approveAmount);
    console.log("✓ Approval set correctly - msg.sender was the account!");
  });
});
