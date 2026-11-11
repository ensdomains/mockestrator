import type { NextFunction, Request, Response } from 'express';

/**
 * The orchestrator API this fork serves: the one @rhinestone/sdk 1.x speaks
 * (1.22 sends it as x-api-version). Upstream main serves 2026-04.blanc
 * (SDK 2.x), whose routes and bodies differ, so a client on another version
 * is refused here instead of failing deep inside a handler.
 */
export const SUPPORTED_API_VERSION = '2026-01.alps';

/** A request without the header (curl, older SDKs) is let through. */
export function requireApiVersion(req: Request, resp: Response, next: NextFunction): void {
    const header = req.headers['x-api-version'];
    if (typeof header === 'string' && header.length > 0 && header !== SUPPORTED_API_VERSION) {
        resp.status(400).json({
            error: `Unsupported x-api-version: ${header}. This mockestrator only supports ${SUPPORTED_API_VERSION}.`,
        });
        return;
    }
    next();
}
