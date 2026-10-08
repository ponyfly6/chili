import XCTest
import WebKit
import Capacitor
@testable import App

private struct BridgeFailure: Error { let code: String }

final class ChiliNativeTests: XCTestCase {
    private var plugin: ChiliNativePlugin!

    override func setUp() { plugin = ChiliNativePlugin() }

    private func invoke(_ method: String, _ options: [String: Any]) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            let call = CAPPluginCall(callbackId: UUID().uuidString, methodName: method,
                options: JSTypes.coerceDictionaryToJSObject(options) ?? [:],
                success: { result, _ in continuation.resume(returning: result?.data ?? [:]) },
                error: { error in continuation.resume(throwing: BridgeFailure(code: error?.code ?? "UNKNOWN")) })!
            switch method {
            case "get": plugin.get(call)
            case "set": plugin.set(call)
            case "remove": plugin.remove(call)
            case "cancel": plugin.cancel(call)
            default: plugin.postJson(call)
            }
        }
    }

    private func fixture() throws -> [String: String] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "FixtureConfig", withExtension: "json"))
        return try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))
    }

    private func post(_ path: String, origin: String? = nil, id: String = UUID().uuidString, maxBytes: Int = 1_048_576) async throws -> [String: Any] {
        let origin = try origin ?? XCTUnwrap(fixture()["trustedOrigin"])
        return try await invoke("postJson", ["id": id, "url": origin + path,
            "headers": ["Content-Type": "application/json", "X-Chili-Control-Client": "native-v1"],
            "body": "{\"message\":\"native bridge fixture\"}", "maxResponseBytes": maxBytes])
    }

    func testKeychainRoundTripAcrossPluginInstancesAndDeletion() async throws {
        let key = "native-tests." + UUID().uuidString
        let first = try await invoke("get", ["key": key])
        XCTAssertTrue(first["value"] is NSNull)
        _ = try await invoke("set", ["key": key, "value": "device-fixture-秘密"])
        plugin = ChiliNativePlugin()
        let restored = try await invoke("get", ["key": key])
        XCTAssertEqual(restored["value"] as? String, "device-fixture-秘密")
        _ = try await invoke("set", ["key": key, "value": "updated"])
        let updated = try await invoke("get", ["key": key])
        XCTAssertEqual(updated["value"] as? String, "updated")
        _ = try await invoke("remove", ["key": key])
        let removed = try await invoke("get", ["key": key])
        XCTAssertTrue(removed["value"] is NSNull)
    }

    func testTrustedTLSUsesRealNativeHTTPWithoutCookies() async throws {
        let response = try await post("/api/echo")
        XCTAssertEqual(response["status"] as? Int, 200)
        let body = try XCTUnwrap(response["body"] as? String)
        let echo = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])
        XCTAssertEqual(echo["method"] as? String, "POST")
        XCTAssertEqual(echo["marker"] as? String, "native-v1")
        XCTAssertTrue(echo["origin"] is NSNull)
        XCTAssertTrue(echo["cookie"] is NSNull)
        // The first response sets a cookie; the second must still omit it.
        let second = try await post("/api/echo")
        let secondBody = try XCTUnwrap(second["body"] as? String)
        let secondEcho = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(secondBody.utf8)) as? [String: Any])
        XCTAssertTrue(secondEcho["cookie"] is NSNull)
    }

    func testUntrustedTLSFailsWithoutTrustOverride() async throws {
        do {
            _ = try await post("/api/echo", origin: XCTUnwrap(fixture()["untrustedOrigin"]))
            XCTFail("An untrusted certificate must never be accepted")
        } catch let error as BridgeFailure { XCTAssertEqual(error.code, "HTTP_REQUEST_FAILED") }
    }

    func testRedirectIsRejectedWithoutFollowingTarget() async throws {
        do { _ = try await post("/api/redirect"); XCTFail("A redirect must be rejected") }
        catch let error as BridgeFailure { XCTAssertEqual(error.code, "REDIRECT_NOT_ALLOWED") }
        let response = try await post("/api/stats")
        let body = try XCTUnwrap(response["body"] as? String)
        let stats = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Int])
        XCTAssertEqual(stats["redirectTargetRequests"], 0)
    }

    func testResponseLimitIsEnforcedByNativeBridge() async throws {
        do { _ = try await post("/api/large", maxBytes: 256); XCTFail("Large response must fail") }
        catch let error as BridgeFailure { XCTAssertEqual(error.code, "RESPONSE_TOO_LARGE") }
    }

    func testNativeCancellationSettlesWithoutWaitingForSlowResponse() async throws {
        let id = UUID().uuidString
        let request = Task { try await self.post("/api/slow", id: id) }
        try await Task.sleep(nanoseconds: 200_000_000)
        _ = try await invoke("cancel", ["id": id])
        do { _ = try await request.value; XCTFail("Cancelled request must fail") }
        catch let error as BridgeFailure { XCTAssertEqual(error.code, "ABORTED") }
    }

    @MainActor
    func testSceneRegistersBridgeAndWebViewSupportsProtocolCrypto() async throws {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let root = try XCTUnwrap(scenes.flatMap(\.windows).first(where: { $0.isKeyWindow })?.rootViewController)
        let controller = try XCTUnwrap(root as? ChiliViewController, "The actual SceneDelegate must install ChiliViewController")
        let webView = try XCTUnwrap(controller.webView)
        var ready = false
        for _ in 0..<150 {
            ready = (try? await webView.evaluateJavaScript("Boolean(window.Capacitor && window.Capacitor.nativePromise)")) as? Bool ?? false
            if ready { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertTrue(ready)
        let result = try await webView.callAsyncJavaScript("""
            const storage = await window.Capacitor.nativePromise('ChiliNative', 'get', { key: 'native-tests.bridge-probe' });
            const data = new TextEncoder().encode('Chili native crypto probe');
            const identity = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
            const signature = await crypto.subtle.sign('Ed25519', identity.privateKey, data);
            const verified = await crypto.subtle.verify('Ed25519', identity.publicKey, signature, data);
            const alice = await crypto.subtle.generateKey('X25519', false, ['deriveBits']);
            const bob = await crypto.subtle.generateKey('X25519', false, ['deriveBits']);
            const aliceSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: bob.publicKey }, alice.privateKey, 256));
            const bobSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: alice.publicKey }, bob.privateKey, 256));
            const agreement = aliceSecret.length === 32 && aliceSecret.every((value, index) => value === bobSecret[index]);
            const material = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), 'HKDF', false, ['deriveKey']);
            const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: data }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
            const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
            return { storage: storage.value === null, verified, agreement, decrypted: new TextDecoder().decode(decrypted) === 'Chili native crypto probe' };
            """, arguments: [:], in: nil, contentWorld: .page)
        let checks = try XCTUnwrap(result as? [String: Bool])
        XCTAssertEqual(checks, ["storage": true, "verified": true, "agreement": true, "decrypted": true])
    }
}
