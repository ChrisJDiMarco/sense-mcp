import CryptoKit
import Foundation
import Security

struct BridgeClient {
    private static let maxPlaintextBytes = 16 * 1_024
    private static let maxEncryptedBytes = 32 * 1_024

    enum BridgeError: LocalizedError {
        case badResponse(Int)
        case badReceipt
        case missingPairingSecret
        case invalidPairingSecret
        case insecureRemoteURL
        case payloadTooLarge
        case authenticationFailed
        case clockSkew

        var errorDescription: String? {
            switch self {
            case .badResponse(let status): return "Bridge returned HTTP \(status)"
            case .badReceipt: return "Bridge returned an unreadable receipt"
            case .missingPairingSecret: return "Paste the Sense pairing link before connecting to a Mac"
            case .invalidPairingSecret: return "The Sense pairing secret is invalid"
            case .insecureRemoteURL: return "Sense bridge connections are restricted to the local network"
            case .payloadTooLarge: return "The bridge payload is too large"
            case .authenticationFailed: return "The bridge response could not be authenticated"
            case .clockSkew: return "The iPhone and Mac clocks differ by more than five minutes"
            }
        }
    }

    func send(payload: SenseContextPayload, to url: URL, token: String) async throws -> BridgeReceipt {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let plaintext = try encoder.encode(payload)
        guard plaintext.count <= Self.maxPlaintextBytes else { throw BridgeError.payloadTooLarge }

        let secret = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !secret.isEmpty else { throw BridgeError.missingPairingSecret }
        guard secret.utf8.count >= 32 else { throw BridgeError.invalidPairingSecret }
        guard Self.isLocalNetwork(url) else { throw BridgeError.insecureRemoteURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 4
        request.setValue("sense-ios/0.2", forHTTPHeaderField: "User-Agent")
        request.setValue("sense-ios", forHTTPHeaderField: "X-Sense-Bridge")

        request.setValue("application/vnd.sense.encrypted+json", forHTTPHeaderField: "Content-Type")
        let requestEnvelope = try BridgeEncryption.seal(
            plaintext,
            secret: secret,
            method: "POST",
            path: url.path
        )
        request.httpBody = try JSONEncoder().encode(requestEnvelope)

        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, data: data)
        let envelope = try decodeEnvelope(data)
        let receiptData = try BridgeEncryption.open(
            envelope,
            secret: secret,
            method: "RESPONSE",
            path: url.path,
            binding: requestEnvelope.nonce
        )
        do {
            return try JSONDecoder().decode(BridgeReceipt.self, from: receiptData)
        } catch {
            throw BridgeError.badReceipt
        }
    }

    func check(to url: URL, token: String) async throws {
        let secret = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !secret.isEmpty else { throw BridgeError.missingPairingSecret }
        guard secret.utf8.count >= 32 else { throw BridgeError.invalidPairingSecret }
        guard Self.isLocalNetwork(url) else { throw BridgeError.insecureRemoteURL }

        let checkURL = url.appendingPathComponent("check")
        var request = URLRequest(url: checkURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 4
        request.setValue("application/vnd.sense.encrypted+json", forHTTPHeaderField: "Content-Type")
        request.setValue("sense-ios/0.2", forHTTPHeaderField: "User-Agent")
        request.setValue("sense-ios", forHTTPHeaderField: "X-Sense-Bridge")
        let requestEnvelope = try BridgeEncryption.seal(
            Data("{}".utf8),
            secret: secret,
            method: "POST",
            path: checkURL.path
        )
        request.httpBody = try JSONEncoder().encode(requestEnvelope)

        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, data: data)
        let encrypted = try decodeEnvelope(data)
        _ = try BridgeEncryption.open(
            encrypted,
            secret: secret,
            method: "RESPONSE",
            path: checkURL.path,
            binding: requestEnvelope.nonce
        )
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard data.count <= Self.maxEncryptedBytes else { throw BridgeError.payloadTooLarge }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw BridgeError.badResponse(http.statusCode)
        }
    }

    private func decodeEnvelope(_ data: Data) throws -> BridgeEnvelope {
        do {
            return try JSONDecoder().decode(BridgeEnvelope.self, from: data)
        } catch {
            throw BridgeError.authenticationFailed
        }
    }

    private static func isLocalNetwork(_ url: URL) -> Bool {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""), let rawHost = url.host else {
            return false
        }
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".local") || host == "::1" { return true }
        if host.contains(":"),
           host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe8") ||
           host.hasPrefix("fe9") || host.hasPrefix("fea") || host.hasPrefix("feb") {
            return true
        }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ 0...255 ~= $0 }) else { return false }
        if octets[0] == 10 || octets[0] == 127 || (octets[0] == 192 && octets[1] == 168) { return true }
        if octets[0] == 172 && (16...31).contains(octets[1]) { return true }
        if octets[0] == 169 && octets[1] == 254 { return true }
        return octets[0] == 100 && (64...127).contains(octets[1])
    }
}

private enum BridgeEncryption {
    private static let maxClockSkewMilliseconds: Int64 = 5 * 60_000

    static func seal(_ plaintext: Data, secret: String, method: String, path: String) throws -> BridgeEnvelope {
        guard secret.utf8.count >= 32 else { throw BridgeClient.BridgeError.invalidPairingSecret }
        let timestamp = Int64((Date().timeIntervalSince1970 * 1_000).rounded())
        let nonceData = try randomBytes(count: 12)
        let nonce = try AES.GCM.Nonce(data: nonceData)
        var envelope = BridgeEnvelope(
            version: 1,
            timestamp: timestamp,
            nonce: nonceData.base64URLString,
            ciphertext: "",
            tag: ""
        )
        let sealed = try AES.GCM.seal(
            plaintext,
            using: key(secret),
            nonce: nonce,
            authenticating: authenticatedData(method: method, path: path, envelope: envelope)
        )
        envelope.ciphertext = sealed.ciphertext.base64URLString
        envelope.tag = sealed.tag.base64URLString
        return envelope
    }

    static func open(
        _ envelope: BridgeEnvelope,
        secret: String,
        method: String,
        path: String,
        binding: String? = nil
    ) throws -> Data {
        guard envelope.version == 1 else { throw BridgeClient.BridgeError.authenticationFailed }
        let now = Int64((Date().timeIntervalSince1970 * 1_000).rounded())
        guard abs(now - envelope.timestamp) <= maxClockSkewMilliseconds else {
            throw BridgeClient.BridgeError.clockSkew
        }
        guard secret.utf8.count >= 32,
              let nonceData = Data(base64URLString: envelope.nonce), nonceData.count == 12,
              let ciphertext = Data(base64URLString: envelope.ciphertext), ciphertext.count <= 16 * 1_024,
              let tag = Data(base64URLString: envelope.tag), tag.count == 16
        else {
            throw BridgeClient.BridgeError.authenticationFailed
        }
        do {
            let nonce = try AES.GCM.Nonce(data: nonceData)
            let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
            return try AES.GCM.open(
                box,
                using: key(secret),
                authenticating: authenticatedData(method: method, path: path, envelope: envelope, binding: binding)
            )
        } catch let error as BridgeClient.BridgeError {
            throw error
        } catch {
            throw BridgeClient.BridgeError.authenticationFailed
        }
    }

    private static func key(_ secret: String) -> SymmetricKey {
        SymmetricKey(data: Data(SHA256.hash(data: Data(secret.utf8))))
    }

    private static func authenticatedData(
        method: String,
        path: String,
        envelope: BridgeEnvelope,
        binding: String? = nil
    ) -> Data {
        let base = "\(envelope.version)\n\(method.uppercased())\n\(path)\n\(envelope.timestamp)\n\(envelope.nonce)"
        return Data((binding.map { "\(base)\n\($0)" } ?? base).utf8)
    }

    private static func randomBytes(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        guard status == errSecSuccess else { throw BridgeClient.BridgeError.authenticationFailed }
        return Data(bytes)
    }
}

private extension Data {
    var base64URLString: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    init?(base64URLString: String) {
        guard base64URLString.range(of: "^[A-Za-z0-9_-]*$", options: .regularExpression) != nil else {
            return nil
        }
        var encoded = base64URLString
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        encoded += String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        self.init(base64Encoded: encoded)
    }
}
