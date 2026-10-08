import Foundation
import Security
import Capacitor

// Only the locally bundled WebView registers this bridge. Never navigate it to
// a remote page: that would grant that page access to device authorization.
@objc(ChiliViewController)
class ChiliViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(ChiliNativePlugin())
    }
}

@objc(ChiliNativePlugin)
public class ChiliNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ChiliNativePlugin"
    public let jsName = "ChiliNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "postJson", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    private let service = "dev.chili.mobile.authorization.v1"
    private let requestsLock = NSLock()
    private var requests: [String: BoundedHTTPSRequest] = [:]

    private func query(_ call: CAPPluginCall) -> [String: Any]? {
        guard let key = call.getString("key"),
              key.range(of: "^[A-Za-z0-9._-]{1,80}$", options: .regularExpression) != nil else {
            call.reject("Invalid secure storage key", "INVALID_STORAGE_KEY")
            return nil
        }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: key,
                kSecAttrSynchronizable as String: false]
    }

    @objc func get(_ call: CAPPluginCall) {
        guard var query = query(call) else { return }
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { call.resolve(["value": NSNull()]); return }
        guard status == errSecSuccess, let data = item as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("Could not read device storage", "SECURE_STORAGE_UNAVAILABLE")
            return
        }
        call.resolve(["value": value])
    }

    @objc func set(_ call: CAPPluginCall) {
        guard var query = query(call) else { return }
        guard let value = call.getString("value"), let data = value.data(using: .utf8), data.count <= 262_144 else {
            call.reject("Secure value is too large", "INVALID_STORAGE_VALUE"); return
        }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            query.merge(attributes) { _, new in new }
            status = SecItemAdd(query as CFDictionary, nil)
        }
        guard status == errSecSuccess else {
            call.reject("Could not save device storage", "SECURE_STORAGE_UNAVAILABLE"); return
        }
        call.resolve()
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let query = query(call) else { return }
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            call.reject("Could not remove device storage", "SECURE_STORAGE_UNAVAILABLE"); return
        }
        call.resolve()
    }

    @objc func postJson(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), UUID(uuidString: id) != nil,
              let address = call.getString("url"), let url = URL(string: address),
              url.scheme == "https", url.host != nil, url.user == nil, url.password == nil,
              url.fragment == nil, url.path.hasPrefix("/api/"),
              let body = call.getString("body"), let data = body.data(using: .utf8), data.count <= 1_048_576,
              let maxBytes = call.getInt("maxResponseBytes"), maxBytes > 0, maxBytes <= 1_048_576,
              let headers = call.getObject("headers") else {
            call.reject("Invalid HTTPS request", "INVALID_NATIVE_REQUEST"); return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.httpBody = data
        request.httpShouldHandleCookies = false
        let allowedHeaders = Set(["content-type", "authorization", "x-chili-control-client"])
        for (name, rawValue) in headers {
            guard allowedHeaders.contains(name.lowercased()), let value = rawValue as? String,
                  !value.contains("\r"), !value.contains("\n") else {
                call.reject("Invalid HTTPS header", "INVALID_NATIVE_REQUEST"); return
            }
            request.setValue(value, forHTTPHeaderField: name)
        }
        let operation = BoundedHTTPSRequest(request: request, maxBytes: maxBytes) { [weak self] result in
            self?.requestsLock.lock()
            self?.requests.removeValue(forKey: id)
            self?.requestsLock.unlock()
            switch result {
            case .success(let response): call.resolve(["status": response.0, "body": response.1])
            case .failure(let error): call.reject("HTTPS request failed", error.code)
            }
        }
        requestsLock.lock()
        guard requests[id] == nil, requests.count < 16 else {
            requestsLock.unlock()
            call.reject("Too many HTTPS requests", "REQUEST_LIMIT_EXCEEDED"); return
        }
        requests[id] = operation
        requestsLock.unlock()
        operation.start()
    }

    @objc func cancel(_ call: CAPPluginCall) {
        if let id = call.getString("id") {
            requestsLock.lock()
            let request = requests[id]
            requestsLock.unlock()
            request?.cancel()
        }
        call.resolve()
    }
}

private struct NativeRequestError: Error { let code: String }

private final class BoundedHTTPSRequest: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let request: URLRequest
    private let maxBytes: Int
    private let completion: (Result<(Int, String), NativeRequestError>) -> Void
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var bytes = Data()
    private var status = 0
    private var failure: NativeRequestError?

    init(request: URLRequest, maxBytes: Int, completion: @escaping (Result<(Int, String), NativeRequestError>) -> Void) {
        self.request = request
        self.maxBytes = maxBytes
        self.completion = completion
    }

    func start() {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCache = nil
        config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 30
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: config, delegate: self, delegateQueue: queue)
        self.session = session
        task = session.dataTask(with: request)
        task?.resume()
    }

    func cancel() { task?.cancel() }

    // No challenge override: platform TLS validation remains mandatory. No
    // redirect is followed, even to the same host, and cookies are never stored.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        failure = NativeRequestError(code: "REDIRECT_NOT_ALLOWED")
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let response = response as? HTTPURLResponse else {
            failure = NativeRequestError(code: "INVALID_HTTP_RESPONSE")
            completionHandler(.cancel); return
        }
        status = response.statusCode
        if response.expectedContentLength > maxBytes {
            failure = NativeRequestError(code: "RESPONSE_TOO_LARGE")
            completionHandler(.cancel); return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard bytes.count + data.count <= maxBytes else {
            failure = NativeRequestError(code: "RESPONSE_TOO_LARGE")
            dataTask.cancel(); return
        }
        bytes.append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { session.finishTasksAndInvalidate(); self.session = nil }
        if let failure { completion(.failure(failure)); return }
        if let error {
            let nsError = error as NSError
            let code = nsError.code == NSURLErrorCancelled ? "ABORTED" : "HTTP_REQUEST_FAILED"
            completion(.failure(NativeRequestError(code: code))); return
        }
        guard let text = String(data: bytes, encoding: .utf8), status != 0 else {
            completion(.failure(NativeRequestError(code: "INVALID_HTTP_RESPONSE"))); return
        }
        completion(.success((status, text)))
    }
}
