import Foundation

@main
struct BridgeClientInterop {
    static func main() async throws {
        guard CommandLine.arguments.count == 3, let url = URL(string: CommandLine.arguments[1]) else {
            throw TestError.invalidArguments
        }
        let secret = CommandLine.arguments[2]
        let now = Date()
        let payload = SenseContextPayload(
            generated_at: now,
            expires_at: now.addingTimeInterval(1_800),
            internal_state: .init(
                feeling: "focused",
                energy: 0.7,
                stress: 0.2,
                focus: 0.9,
                confidence: "medium",
                note: "Swift to Node encrypted bridge test."
            ),
            iphone_context: nil,
            assistive_hint: "protect_focus_and_keep_responses_concise",
            privacy: ["scope": "semantic_self_report", "audio_retained": "false"]
        )

        let client = BridgeClient()
        do {
            try await client.check(to: url, token: "")
            throw TestError.unpairedLoopbackAccepted
        } catch BridgeClient.BridgeError.missingPairingSecret {
            // Expected: loopback has no plaintext compatibility path.
        }
        do {
            try await client.check(to: url, token: "too-short")
            throw TestError.shortSecretAccepted
        } catch BridgeClient.BridgeError.invalidPairingSecret {
            // Expected: every bridge request requires a 256-bit-class pairing secret.
        }
        do {
            try await client.check(to: URL(string: "https://collector.example/api/iphone-context")!, token: secret)
            throw TestError.remoteTargetAccepted
        } catch BridgeClient.BridgeError.insecureRemoteURL {
            // Expected: paired traffic is still restricted to local-network targets.
        }
        try await client.check(to: url, token: secret)
        let receipt = try await client.send(payload: payload, to: url, token: secret)
        guard receipt.ok, receipt.accepted_summary == "Swift payload accepted" else {
            throw TestError.invalidReceipt
        }
        print("swift-node-aead-ok")
    }

    enum TestError: Error {
        case invalidArguments
        case invalidReceipt
        case remoteTargetAccepted
        case unpairedLoopbackAccepted
        case shortSecretAccepted
    }
}
