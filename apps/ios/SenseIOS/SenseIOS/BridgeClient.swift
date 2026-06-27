import Foundation

struct BridgeClient {
    enum BridgeError: LocalizedError {
        case badResponse(Int)
        case badReceipt

        var errorDescription: String? {
            switch self {
            case .badResponse(let status): return "Bridge returned HTTP \(status)"
            case .badReceipt: return "Bridge returned an unreadable receipt"
            }
        }
    }

    func send(payload: SenseContextPayload, to url: URL, token: String = "") async throws -> BridgeReceipt {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 4
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("sense-ios/0.1", forHTTPHeaderField: "User-Agent")
        request.setValue("sense-ios", forHTTPHeaderField: "X-Sense-Bridge")
        setBearerToken(token, on: &request)

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        request.httpBody = try encoder.encode(payload)

        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw BridgeError.badResponse(http.statusCode)
        }
        guard !data.isEmpty else {
            return BridgeReceipt(ok: true, accepted_summary: "Accepted by Mac; no receipt body returned.")
        }

        do {
            return try JSONDecoder().decode(BridgeReceipt.self, from: data)
        } catch {
            throw BridgeError.badReceipt
        }
    }

    func check(to url: URL, token: String = "") async throws {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 4
        request.setValue("sense-ios/0.1", forHTTPHeaderField: "User-Agent")
        request.setValue("sense-ios", forHTTPHeaderField: "X-Sense-Bridge")
        setBearerToken(token, on: &request)

        let (_, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw BridgeError.badResponse(http.statusCode)
        }
    }

    private func setBearerToken(_ token: String, on request: inout URLRequest) {
        let clean = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        request.setValue("Bearer \(clean)", forHTTPHeaderField: "Authorization")
    }
}
