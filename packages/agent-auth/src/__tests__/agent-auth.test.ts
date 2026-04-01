import { describe, it, expect, vi, afterEach } from "vitest";
import { base64UrlEncode, base64UrlDecode } from "../encoding.js";
import { signToken } from "../sign.js";
import { verifyToken } from "../verify.js";
import { setAuthHeaders, getAuthFromRequest } from "../headers.js";

// ---------------------------------------------------------------------------
// encoding.ts
// ---------------------------------------------------------------------------

describe("base64UrlEncode", () => {
	it("encodes empty bytes to empty string", () => {
		expect(base64UrlEncode(new Uint8Array([]))).toBe("");
	});

	it("encodes bytes to a URL-safe base64 string", () => {
		const bytes = new TextEncoder().encode("hello world");
		const encoded = base64UrlEncode(bytes);
		// Must not contain +, /, or trailing =
		expect(encoded).not.toMatch(/[+/=]/);
	});

	it("replaces + with - and / with _", () => {
		// Bytes that produce + and / in standard base64: 0xfb, 0xff, 0xfe
		const bytes = new Uint8Array([0xfb, 0xff, 0xfe]);
		const encoded = base64UrlEncode(bytes);
		expect(encoded).not.toContain("+");
		expect(encoded).not.toContain("/");
	});

	it("strips trailing padding", () => {
		// "a" in base64 is "YQ==" — two padding chars
		const bytes = new TextEncoder().encode("a");
		const encoded = base64UrlEncode(bytes);
		expect(encoded).not.toContain("=");
		expect(encoded).toBe("YQ");
	});
});

describe("base64UrlDecode", () => {
	it("decodes empty string to empty bytes", () => {
		const decoded = base64UrlDecode("");
		expect(decoded.length).toBe(0);
	});

	it("round-trips with base64UrlEncode", () => {
		const original = new TextEncoder().encode("hello world 🌍");
		const encoded = base64UrlEncode(original);
		const decoded = base64UrlDecode(encoded);
		expect(decoded).toEqual(original);
	});

	it("decodes strings without padding", () => {
		// "YQ" is "a" without padding
		const decoded = base64UrlDecode("YQ");
		expect(new TextDecoder().decode(decoded)).toBe("a");
	});

	it("handles URL-safe characters (- and _)", () => {
		const bytes = new Uint8Array([0xfb, 0xff, 0xfe]);
		const encoded = base64UrlEncode(bytes);
		const decoded = base64UrlDecode(encoded);
		expect(decoded).toEqual(bytes);
	});

	it("throws on invalid base64 input", () => {
		expect(() => base64UrlDecode("!!!invalid!!!")).toThrow();
	});
});

// ---------------------------------------------------------------------------
// sign.ts + verify.ts (round-trip)
// ---------------------------------------------------------------------------

describe("signToken", () => {
	it("returns a string with payload:signature format", async () => {
		const token = await signToken("agent-a", "agent-b", "my-secret");
		expect(token).toContain(":");
		const parts = token.split(":");
		expect(parts.length).toBe(2);
		expect(parts[0].length).toBeGreaterThan(0);
		expect(parts[1].length).toBeGreaterThan(0);
	});

	it("produces different tokens for different sender/target pairs", async () => {
		const t1 = await signToken("agent-a", "agent-b", "secret");
		const t2 = await signToken("agent-c", "agent-d", "secret");
		expect(t1).not.toBe(t2);
	});

	it("produces different tokens for different secrets", async () => {
		const t1 = await signToken("agent-a", "agent-b", "secret-1");
		const t2 = await signToken("agent-a", "agent-b", "secret-2");
		// Payloads may differ (timestamp) but signatures definitely differ
		const sig1 = t1.split(":")[1];
		const sig2 = t2.split(":")[1];
		expect(sig1).not.toBe(sig2);
	});

	it("embeds sender, target, and timestamp in the payload", async () => {
		const before = Date.now();
		const token = await signToken("sender-1", "target-1", "secret");
		const after = Date.now();

		const payloadB64 = token.split(":")[0];
		const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
		const payload = JSON.parse(payloadJson);

		expect(payload.sender).toBe("sender-1");
		expect(payload.target).toBe("target-1");
		expect(payload.ts).toBeGreaterThanOrEqual(before);
		expect(payload.ts).toBeLessThanOrEqual(after);
	});
});

describe("verifyToken", () => {
	const SECRET = "test-secret-key";

	it("verifies a valid token and returns the payload", async () => {
		const token = await signToken("agent-a", "agent-b", SECRET);
		const payload = await verifyToken(token, "agent-b", SECRET);
		expect(payload).not.toBeNull();
		expect(payload!.sender).toBe("agent-a");
		expect(payload!.target).toBe("agent-b");
		expect(typeof payload!.ts).toBe("number");
	});

	it("rejects a token signed with a different secret", async () => {
		const token = await signToken("agent-a", "agent-b", "secret-1");
		const payload = await verifyToken(token, "agent-b", "wrong-secret");
		expect(payload).toBeNull();
	});

	it("rejects a token with the wrong target", async () => {
		const token = await signToken("agent-a", "agent-b", SECRET);
		const payload = await verifyToken(token, "agent-c", SECRET);
		expect(payload).toBeNull();
	});

	it("rejects a token without a colon separator", async () => {
		const payload = await verifyToken("no-separator-here", "agent-b", SECRET);
		expect(payload).toBeNull();
	});

	it("rejects a token with invalid base64 in payload", async () => {
		const payload = await verifyToken("!!!:validpart", "agent-b", SECRET);
		expect(payload).toBeNull();
	});

	it("rejects a token with invalid base64 in signature", async () => {
		const token = await signToken("agent-a", "agent-b", SECRET);
		const payloadB64 = token.split(":")[0];
		const payload = await verifyToken(`${payloadB64}:!!!invalid`, "agent-b", SECRET);
		expect(payload).toBeNull();
	});

	it("rejects a token with tampered payload", async () => {
		const token = await signToken("agent-a", "agent-b", SECRET);
		const [, sig] = token.split(":");
		// Create a different payload
		const tamperedPayload = base64UrlEncode(
			new TextEncoder().encode(JSON.stringify({ sender: "evil", target: "agent-b", ts: Date.now() })),
		);
		const payload = await verifyToken(`${tamperedPayload}:${sig}`, "agent-b", SECRET);
		expect(payload).toBeNull();
	});

	it("rejects a token with tampered signature", async () => {
		const token = await signToken("agent-a", "agent-b", SECRET);
		const [payloadB64] = token.split(":");
		// Flip a character in the signature
		const sig = token.split(":")[1];
		const flipped = sig[0] === "a" ? "b" + sig.slice(1) : "a" + sig.slice(1);
		const payload = await verifyToken(`${payloadB64}:${flipped}`, "agent-b", SECRET);
		expect(payload).toBeNull();
	});

	describe("TTL enforcement", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("rejects an expired token (default TTL)", async () => {
			// Sign a token, then advance time past the 60s default TTL
			const token = await signToken("agent-a", "agent-b", SECRET);

			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);

			const payload = await verifyToken(token, "agent-b", SECRET);
			expect(payload).toBeNull();
		});

		it("accepts a token within custom TTL", async () => {
			const token = await signToken("agent-a", "agent-b", SECRET);

			// Advance 30s — within 120s custom TTL
			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30_000);

			const payload = await verifyToken(token, "agent-b", SECRET, 120_000);
			expect(payload).not.toBeNull();
		});

		it("rejects a token outside custom TTL", async () => {
			const token = await signToken("agent-a", "agent-b", SECRET);

			vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);

			const payload = await verifyToken(token, "agent-b", SECRET, 5_000);
			expect(payload).toBeNull();
		});

		it("rejects a token with a timestamp far in the past", async () => {
			// Sign with a mocked past timestamp
			const pastTime = Date.now() - 120_000;
			vi.spyOn(Date, "now").mockReturnValue(pastTime);
			const token = await signToken("agent-a", "agent-b", SECRET);
			vi.restoreAllMocks();

			// Verify at real time — drift is ~120s, exceeds default 60s TTL
			const payload = await verifyToken(token, "agent-b", SECRET);
			expect(payload).toBeNull();
		});
	});

	it("rejects a token with future timestamp beyond TTL (absolute drift)", async () => {
		// Create token manually with a future timestamp
		const futureTs = Date.now() + 120_000;
		const payload = JSON.stringify({ sender: "agent-a", target: "agent-b", ts: futureTs });
		const payloadBytes = new TextEncoder().encode(payload);
		const payloadB64 = base64UrlEncode(payloadBytes);

		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(SECRET),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const sigBuf = await crypto.subtle.sign("HMAC", key, payloadBytes);
		const sigB64 = base64UrlEncode(new Uint8Array(sigBuf));

		const token = `${payloadB64}:${sigB64}`;
		// Default TTL is 60s, but token is 120s in the future — |drift| = 120s > 60s
		const result = await verifyToken(token, "agent-b", SECRET);
		expect(result).toBeNull();
	});

	it("accepts a token with slightly future timestamp within TTL", async () => {
		// Token 5s in the future, well within default 60s TTL
		const futureTs = Date.now() + 5_000;
		const payload = JSON.stringify({ sender: "agent-a", target: "agent-b", ts: futureTs });
		const payloadBytes = new TextEncoder().encode(payload);
		const payloadB64 = base64UrlEncode(payloadBytes);

		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(SECRET),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const sigBuf = await crypto.subtle.sign("HMAC", key, payloadBytes);
		const sigB64 = base64UrlEncode(new Uint8Array(sigBuf));

		const token = `${payloadB64}:${sigB64}`;
		const result = await verifyToken(token, "agent-b", SECRET);
		expect(result).not.toBeNull();
		expect(result!.sender).toBe("agent-a");
	});

	it("rejects a token with non-JSON payload (valid base64 but not JSON)", async () => {
		const garbagePayload = base64UrlEncode(new TextEncoder().encode("not json"));

		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(SECRET),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const payloadBytes = new TextEncoder().encode("not json");
		const sigBuf = await crypto.subtle.sign("HMAC", key, payloadBytes);
		const sigB64 = base64UrlEncode(new Uint8Array(sigBuf));

		const result = await verifyToken(`${garbagePayload}:${sigB64}`, "agent-b", SECRET);
		// Signature is valid but payload is not JSON — should return null
		// Actually the verify step checks signature against payloadBytes which is "not json"
		// and that matches, so signature is valid. But JSON.parse will fail.
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// headers.ts
// ---------------------------------------------------------------------------

describe("setAuthHeaders", () => {
	it("sets x-agent-token and x-agent-id headers", () => {
		const headers = new Headers();
		setAuthHeaders(headers, "my-token", "agent-1");
		expect(headers.get("x-agent-token")).toBe("my-token");
		expect(headers.get("x-agent-id")).toBe("agent-1");
	});

	it("overwrites existing header values", () => {
		const headers = new Headers();
		headers.set("x-agent-token", "old-token");
		headers.set("x-agent-id", "old-id");
		setAuthHeaders(headers, "new-token", "new-id");
		expect(headers.get("x-agent-token")).toBe("new-token");
		expect(headers.get("x-agent-id")).toBe("new-id");
	});
});

describe("getAuthFromRequest", () => {
	it("extracts token and senderId from request headers", () => {
		const request = new Request("https://example.com", {
			headers: {
				"x-agent-token": "my-token",
				"x-agent-id": "agent-1",
			},
		});
		const auth = getAuthFromRequest(request);
		expect(auth).toEqual({ token: "my-token", senderId: "agent-1" });
	});

	it("returns null when x-agent-token is missing", () => {
		const request = new Request("https://example.com", {
			headers: { "x-agent-id": "agent-1" },
		});
		expect(getAuthFromRequest(request)).toBeNull();
	});

	it("returns null when x-agent-id is missing", () => {
		const request = new Request("https://example.com", {
			headers: { "x-agent-token": "my-token" },
		});
		expect(getAuthFromRequest(request)).toBeNull();
	});

	it("returns null when both headers are missing", () => {
		const request = new Request("https://example.com");
		expect(getAuthFromRequest(request)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Integration: sign + setHeaders + getAuth + verify
// ---------------------------------------------------------------------------

describe("end-to-end auth flow", () => {
	it("signs, sets headers, extracts, and verifies", async () => {
		const secret = "shared-secret";
		const sender = "agent-alpha";
		const target = "agent-beta";

		// 1. Sign
		const token = await signToken(sender, target, secret);

		// 2. Set headers on outgoing request
		const headers = new Headers();
		setAuthHeaders(headers, token, sender);

		// 3. Extract from incoming request
		const request = new Request("https://example.com", { headers });
		const auth = getAuthFromRequest(request);
		expect(auth).not.toBeNull();

		// 4. Verify
		const payload = await verifyToken(auth!.token, target, secret);
		expect(payload).not.toBeNull();
		expect(payload!.sender).toBe(sender);
		expect(payload!.target).toBe(target);
	});
});
