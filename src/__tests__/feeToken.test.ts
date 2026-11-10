import { describe, expect, it } from "vitest";
import { withoutAddressFeeToken } from "../feeToken";
import { zPostIntentsRouteData } from "../gen/zod.gen";

const MOCK_USDC = "0x240b0316Df57887DBBE58b586508b19e633a14aa";

const feeTokenIssues = (feeToken: string) =>
    (
        zPostIntentsRouteData.safeParse({
            body: withoutAddressFeeToken({ options: { feeToken } }),
            query: undefined,
            path: undefined,
            headers: {},
        }).error?.issues ?? []
    ).filter((issue) => issue.path.includes("feeToken"));

describe("withoutAddressFeeToken", () => {
    it.each([MOCK_USDC, MOCK_USDC.toLowerCase(), "USDC"])("accepts a fee token of %s", (feeToken) => {
        expect(feeTokenIssues(feeToken)).toEqual([]);
    });

    it("still rejects a fee token that is neither a listed symbol nor an address", () => {
        expect(feeTokenIssues("DOGE")).toHaveLength(1);
    });
});
