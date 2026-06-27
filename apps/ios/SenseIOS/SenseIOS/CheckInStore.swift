import Combine
import Foundation

@MainActor
final class CheckInStore: ObservableObject {
    @Published var selectedFeeling: FeelingTag = .steady
    @Published var energy: Double = 0.62
    @Published var stress: Double = 0.28
    @Published var focus: Double = 0.70
    @Published var note: String = ""
    @Published var contextMode: String = "manual"
    @Published var semanticTags: [String] = []
    @Published var expiry: ExpiryPreset = .twoHours
    @Published var bridgeURLString: String
    @Published var bridgeTokenString: String
    @Published var checkIns: [CheckIn] = []
    @Published var bridgeStatus: BridgeStatus = .idle
    @Published var shouldStartListening = false

    private let bridgeClient = BridgeClient()
    private let defaults: UserDefaults
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.bridgeURLString = defaults.string(forKey: "bridgeURLString") ?? "http://127.0.0.1:3777/api/iphone-context"
        self.bridgeTokenString = defaults.string(forKey: "bridgeTokenString") ?? ""
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
        load()
        if defaults.bool(forKey: "LaunchCheckIn") {
            defaults.set(false, forKey: "LaunchCheckIn")
            activateCheckInFromShortcut()
        }
    }

    var activeCheckIn: CheckIn? {
        checkIns.first { !$0.isExpired }
    }

    func previewPayload(sensorSnapshot: IphoneSensorSnapshot? = nil) -> SenseContextPayload {
        makePayload(note: note, sensorSnapshot: sensorSnapshot)
    }

    func activateCheckInFromShortcut() {
        shouldStartListening = true
    }

    func resetDraft() {
        selectedFeeling = .steady
        energy = 0.62
        stress = 0.28
        focus = 0.70
        note = ""
        contextMode = "manual"
        semanticTags = []
        expiry = .twoHours
    }

    func saveBridgeURL() {
        defaults.set(bridgeURLString, forKey: "bridgeURLString")
        defaults.set(bridgeTokenString, forKey: "bridgeTokenString")
    }

    func createCheckIn(sensorSnapshot: IphoneSensorSnapshot?) async {
        saveBridgeURL()
        let payload = makePayload(
            note: note.trimmingCharacters(in: .whitespacesAndNewlines),
            sensorSnapshot: sensorSnapshot
        )
        let checkIn = CheckIn(
            expiresAt: payload.expires_at,
            feeling: selectedFeeling,
            energy: energy,
            stress: stress,
            focus: focus,
            note: payload.internal_state.note,
            payload: payload
        )

        checkIns.insert(checkIn, at: 0)
        checkIns = Array(checkIns.prefix(12))
        bridgeStatus = .savedLocally
        persist()
        if let receipt = await send(payload) {
            checkIns[0].receipt = receipt
            persist()
        }
    }

    func sendLatestAgain() async {
        guard let payload = checkIns.first?.payload else { return }
        if let receipt = await send(payload) {
            checkIns[0].receipt = receipt
            persist()
        }
    }

    func testBridgeConnection() async {
        saveBridgeURL()
        guard let url = URL(string: bridgeURLString) else {
            bridgeStatus = .failed("Invalid bridge URL")
            return
        }

        bridgeStatus = .sending
        do {
            try await bridgeClient.check(to: url, token: bridgeTokenString)
            bridgeStatus = .connected
        } catch {
            bridgeStatus = .failed(error.localizedDescription)
        }
    }

    func delete(_ checkIn: CheckIn) {
        checkIns.removeAll { $0.id == checkIn.id }
        persist()
    }

    func payloadJSON(_ payload: SenseContextPayload? = nil) -> String {
        let payload = payload ?? previewPayload()
        let localEncoder = JSONEncoder()
        localEncoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        localEncoder.dateEncodingStrategy = .iso8601
        guard let data = try? localEncoder.encode(payload),
              let text = String(data: data, encoding: .utf8)
        else {
            return "{}"
        }
        return text
    }

    private func send(_ payload: SenseContextPayload) async -> BridgeReceipt? {
        guard let url = URL(string: bridgeURLString) else {
            bridgeStatus = .failed("Invalid bridge URL")
            return nil
        }

        bridgeStatus = .sending
        do {
            let receipt = try await bridgeClient.send(payload: payload, to: url, token: bridgeTokenString)
            bridgeStatus = .sent
            return receipt
        } catch {
            if case BridgeClient.BridgeError.badResponse = error {
                bridgeStatus = .rejected(error.localizedDescription)
            } else if case BridgeClient.BridgeError.badReceipt = error {
                bridgeStatus = .receiptError(error.localizedDescription)
            } else {
                bridgeStatus = .failed(error.localizedDescription)
            }
            return nil
        }
    }

    private func makePayload(note: String, sensorSnapshot: IphoneSensorSnapshot? = nil) -> SenseContextPayload {
        let now = Date()
        let expiresAt = Calendar.current.date(byAdding: .minute, value: expiry.minutes, to: now) ?? now.addingTimeInterval(Double(expiry.minutes) * 60)
        let cleanNote = note.isEmpty ? synthesizedNote() : note
        return SenseContextPayload(
            generated_at: now,
            expires_at: expiresAt,
            internal_state: .init(
                feeling: selectedFeeling.rawValue,
                energy: energy,
                stress: stress,
                focus: focus,
                confidence: cleanNote == synthesizedNote() ? "low" : "medium",
                note: cleanNote,
                context_mode: contextMode,
                semantic_tags: semanticTags.isEmpty ? nil : semanticTags
            ),
            iphone_context: sensorSnapshot,
            assistive_hint: assistiveHint(),
            privacy: [
                "scope": "semantic_self_report",
                "audio_retained": "false",
                "expires": "\(expiry.minutes)m",
                "iphone_signals": sensorSnapshot == nil ? "none" : "device_motion_noise_health_summary",
                "health_scope": sensorSnapshot?.health == nil ? "none" : "summary_only",
            ]
        )
    }

    private func synthesizedNote() -> String {
        "User reported feeling \(selectedFeeling.rawValue), with energy \(energy.percentageLabel), stress \(stress.percentageLabel), and focus \(focus.percentageLabel)."
    }

    private func assistiveHint() -> String {
        if stress > 0.72 && focus < 0.45 {
            return "reduce_scope_and_offer_one_next_step"
        }
        if selectedFeeling == .blocked {
            return "help_unblock_with_options"
        }
        if focus > 0.78 && stress < 0.45 {
            return "protect_focus_and_keep_responses_concise"
        }
        if energy < 0.35 {
            return "use_low_energy_mode"
        }
        return "adapt_tone_to_current_internal_state"
    }

    private func load() {
        guard let data = defaults.data(forKey: "checkIns"),
              let saved = try? decoder.decode([CheckIn].self, from: data)
        else { return }
        checkIns = saved.filter { !$0.isExpired || Calendar.current.isDateInToday($0.createdAt) }
    }

    private func persist() {
        guard let data = try? encoder.encode(checkIns) else { return }
        defaults.set(data, forKey: "checkIns")
    }
}
