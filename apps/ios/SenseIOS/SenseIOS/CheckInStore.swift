import Combine
import Foundation
import Security

enum CheckInPersistenceError: Error {
    case exceedsLimit
    case unsafeFile
}

protocol CheckInPersisting {
    var maximumBytes: Int { get }
    func load() throws -> Data?
    func save(_ data: Data) throws
    func remove() throws
}

struct ProtectedCheckInFileStore: CheckInPersisting {
    private static let hardMaximumBytes = 256 * 1_024
    static let writeOptions: Data.WritingOptions = [.atomic, .completeFileProtection]
    static let fileProtection: FileProtectionType = .complete

    let fileURL: URL
    let maximumBytes: Int

    init(
        fileURL: URL = ProtectedCheckInFileStore.defaultFileURL(),
        maximumBytes: Int = 256 * 1_024
    ) {
        self.fileURL = fileURL
        self.maximumBytes = min(max(1, maximumBytes), Self.hardMaximumBytes)
    }

    func load() throws -> Data? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        let values = try fileURL.resourceValues(forKeys: [
            .fileSizeKey,
            .isRegularFileKey,
            .isSymbolicLinkKey,
        ])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw CheckInPersistenceError.unsafeFile
        }
        guard let fileSize = values.fileSize, fileSize <= maximumBytes else {
            throw CheckInPersistenceError.exceedsLimit
        }

        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: maximumBytes + 1) ?? Data()
        guard data.count <= maximumBytes else { throw CheckInPersistenceError.exceedsLimit }
        return data
    }

    func save(_ data: Data) throws {
        guard data.count <= maximumBytes else { throw CheckInPersistenceError.exceedsLimit }
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: Self.fileProtection]
        )
        try FileManager.default.setAttributes(
            [.protectionKey: Self.fileProtection],
            ofItemAtPath: directory.path
        )
        var excludedDirectory = directory
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        try? excludedDirectory.setResourceValues(resourceValues)

        try data.write(to: fileURL, options: Self.writeOptions)
        try FileManager.default.setAttributes(
            [.protectionKey: Self.fileProtection],
            ofItemAtPath: fileURL.path
        )
    }

    func remove() throws {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        try FileManager.default.removeItem(at: fileURL)
    }

    private static func defaultFileURL() -> URL {
        let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        return applicationSupport
            .appendingPathComponent("Sense", isDirectory: true)
            .appendingPathComponent("check-ins-v1.json", isDirectory: false)
    }
}

struct ShortcutDraft: Codable, Equatable {
    let feeling: String
    let note: String
}

protocol ShortcutDraftStoring {
    func load() throws -> ShortcutDraft?
    func save(_ draft: ShortcutDraft) throws
    func remove() throws
}

struct ProtectedShortcutDraftStore: ShortcutDraftStoring {
    private let persistence: any CheckInPersisting

    init(
        persistence: any CheckInPersisting = ProtectedCheckInFileStore(
            fileURL: ProtectedShortcutDraftStore.defaultFileURL(),
            maximumBytes: 16 * 1_024
        )
    ) {
        self.persistence = persistence
    }

    func load() throws -> ShortcutDraft? {
        guard let data = try persistence.load() else { return nil }
        return try JSONDecoder().decode(ShortcutDraft.self, from: data)
    }

    func save(_ draft: ShortcutDraft) throws {
        try persistence.save(JSONEncoder().encode(draft))
    }

    func remove() throws {
        try persistence.remove()
    }

    private static func defaultFileURL() -> URL {
        let applicationSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent("Library/Application Support", isDirectory: true)
        return applicationSupport
            .appendingPathComponent("Sense", isDirectory: true)
            .appendingPathComponent("shortcut-draft-v1.json", isDirectory: false)
    }
}

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
    @Published private(set) var pendingPairingHost: String?

    private let bridgeClient = BridgeClient()
    private let secretStore: any BridgeSecretStoring
    private let checkInPersistence: any CheckInPersisting
    private let shortcutDraftStore: any ShortcutDraftStoring
    private let defaults: UserDefaults
    private let now: () -> Date
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var pendingPairingURL: URL?

    init(
        defaults: UserDefaults = .standard,
        secretStore: any BridgeSecretStoring = BridgeSecretStore(),
        checkInPersistence: any CheckInPersisting = ProtectedCheckInFileStore(),
        shortcutDraftStore: any ShortcutDraftStoring = ProtectedShortcutDraftStore(),
        now: @escaping () -> Date = Date.init
    ) {
        let legacySecret = defaults.string(forKey: "bridgeTokenString")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if secretStore.read() == nil, !legacySecret.isEmpty {
            _ = secretStore.save(legacySecret)
        }
        defaults.removeObject(forKey: "bridgeTokenString")

        self.secretStore = secretStore
        self.checkInPersistence = checkInPersistence
        self.shortcutDraftStore = shortcutDraftStore
        self.defaults = defaults
        self.now = now
        self.bridgeURLString = ""
        self.bridgeTokenString = ""
        encoder.dateEncodingStrategy = .iso8601
        decoder.dateDecodingStrategy = .iso8601
        if let savedURLString = defaults.string(forKey: "bridgeURLString"),
           let savedURL = URL(string: savedURLString),
           isSafeBridgeURL(savedURL),
           (secretStore.read()?.utf8.count ?? 0) >= 32 {
            bridgeURLString = savedURL.absoluteString
        } else {
            defaults.removeObject(forKey: "bridgeURLString")
        }
        load()
        consumeShortcutDraft()
        if defaults.bool(forKey: "LaunchCheckIn") {
            defaults.set(false, forKey: "LaunchCheckIn")
            activateCheckInFromShortcut()
        }
    }

    var activeCheckIn: CheckIn? {
        pruneExpiredCheckIns()
        return checkIns.first
    }

    func previewPayload(sensorSnapshot: IphoneSensorSnapshot? = nil) -> SenseContextPayload {
        makePayload(note: note, sensorSnapshot: sensorSnapshot)
    }

    func activateCheckInFromShortcut() {
        shouldStartListening = true
    }

    func consumeShortcutDraft() {
        let legacyFeeling = defaults.string(forKey: "ShortcutFeeling")
        let legacyNote = defaults.string(forKey: "ShortcutNote")
        defaults.removeObject(forKey: "ShortcutFeeling")
        defaults.removeObject(forKey: "ShortcutNote")

        let protectedDraft: ShortcutDraft?
        do {
            protectedDraft = try shortcutDraftStore.load()
        } catch {
            try? shortcutDraftStore.remove()
            protectedDraft = nil
        }
        let feelingValue = protectedDraft?.feeling ?? legacyFeeling
        let noteValue = protectedDraft?.note ?? legacyNote
        if let feelingValue,
           let feeling = FeelingTag(rawValue: feelingValue.lowercased()) {
            selectedFeeling = feeling
        }
        if let noteValue {
            note = noteValue
        }
        if protectedDraft != nil {
            try? shortcutDraftStore.remove()
        }
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
        defaults.removeObject(forKey: "bridgeTokenString")
        guard let url = URL(string: bridgeURLString.trimmingCharacters(in: .whitespacesAndNewlines)),
              isSafeBridgeURL(url)
        else {
            bridgeStatus = .failed("Pair with a Mac before sending")
            return
        }
        let candidate = bridgeTokenString.trimmingCharacters(in: .whitespacesAndNewlines)
        if !candidate.isEmpty {
            guard candidate.utf8.count >= 32 else {
                bridgeStatus = .failed("Pairing secret is too short")
                return
            }
            guard secretStore.save(candidate) else {
                bridgeStatus = .failed("Could not secure the pairing secret in Keychain")
                return
            }
            bridgeTokenString = ""
        }
        guard (secretStore.read()?.utf8.count ?? 0) >= 32 else {
            bridgeStatus = .failed("Pair with a Mac before sending")
            return
        }
        bridgeURLString = url.absoluteString
        defaults.set(bridgeURLString, forKey: "bridgeURLString")
    }

    @discardableResult
    func handlePairingLink(_ url: URL) -> Bool {
        guard let pairing = validatedPairing(url)
        else {
            bridgeStatus = .failed("The Sense pairing link is invalid")
            return false
        }
        guard secretStore.save(pairing.secret) else {
            bridgeStatus = .failed("The Sense pairing link is invalid")
            return false
        }
        bridgeURLString = pairing.target.absoluteString
        bridgeTokenString = ""
        defaults.set(bridgeURLString, forKey: "bridgeURLString")
        defaults.removeObject(forKey: "bridgeTokenString")
        bridgeStatus = .paired
        return true
    }

    func stagePairingLink(_ url: URL) {
        guard let pairing = validatedPairing(url) else {
            bridgeStatus = .failed("The Sense pairing link is invalid")
            return
        }
        pendingPairingURL = url
        pendingPairingHost = pairing.target.host
    }

    func confirmPendingPairing() {
        guard let url = pendingPairingURL else { return }
        clearPendingPairing()
        handlePairingLink(url)
    }

    func clearPendingPairing() {
        pendingPairingURL = nil
        pendingPairingHost = nil
    }

    @discardableResult
    func handlePairingLink(_ value: String) -> Bool {
        guard let url = URL(string: value.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            bridgeStatus = .failed("The clipboard does not contain a Sense pairing link")
            return false
        }
        return handlePairingLink(url)
    }

    func createCheckIn(sensorSnapshot: IphoneSensorSnapshot?) async {
        saveBridgeURL()
        pruneExpiredCheckIns()
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
        pruneExpiredCheckIns()
        guard let payload = checkIns.first?.payload else { return }
        if let receipt = await send(payload) {
            checkIns[0].receipt = receipt
            persist()
        }
    }

    func testBridgeConnection() async {
        saveBridgeURL()
        guard let pairing = pairedBridge() else {
            bridgeStatus = .failed("Pair with a Mac before connecting")
            return
        }

        bridgeStatus = .sending
        do {
            try await bridgeClient.check(to: pairing.url, token: pairing.secret)
            bridgeStatus = .connected
        } catch {
            bridgeStatus = .failed(error.localizedDescription)
        }
    }

    func delete(_ checkIn: CheckIn) {
        pruneExpiredCheckIns()
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
        guard let pairing = pairedBridge() else {
            bridgeStatus = .failed("Pair with a Mac before sending")
            return nil
        }

        bridgeStatus = .sending
        do {
            let receipt = try await bridgeClient.send(
                payload: payload,
                to: pairing.url,
                token: pairing.secret
            )
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
        let generatedAt = now()
        let expiresAt = Calendar.current.date(byAdding: .minute, value: expiry.minutes, to: generatedAt) ?? generatedAt.addingTimeInterval(Double(expiry.minutes) * 60)
        let cleanNote = note.isEmpty ? synthesizedNote() : note
        return SenseContextPayload(
            generated_at: generatedAt,
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

    private func currentBridgeSecret() -> String {
        let draft = bridgeTokenString.trimmingCharacters(in: .whitespacesAndNewlines)
        return draft.isEmpty ? (secretStore.read() ?? "") : draft
    }

    private func pairedBridge() -> (url: URL, secret: String)? {
        guard let url = URL(string: bridgeURLString), isSafeBridgeURL(url) else { return nil }
        let secret = currentBridgeSecret().trimmingCharacters(in: .whitespacesAndNewlines)
        return secret.utf8.count >= 32 ? (url, secret) : nil
    }

    private func isSafeBridgeURL(_ url: URL) -> Bool {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let host = url.host,
              isLocalBridgeHost(host),
              url.user == nil,
              url.password == nil,
              url.fragment == nil,
              url.query == nil,
              url.path == "/api/iphone-context"
        else { return false }
        return true
    }

    private func isLocalBridgeHost(_ rawHost: String) -> Bool {
        let host = rawHost.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host.hasSuffix(".local") || host == "::1" { return true }
        if host.hasPrefix("fc") || host.hasPrefix("fd") || host.hasPrefix("fe8") ||
            host.hasPrefix("fe9") || host.hasPrefix("fea") || host.hasPrefix("feb") {
            return host.contains(":")
        }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ 0...255 ~= $0 }) else { return false }
        if octets[0] == 10 || octets[0] == 127 || (octets[0] == 192 && octets[1] == 168) { return true }
        if octets[0] == 172 && (16...31).contains(octets[1]) { return true }
        if octets[0] == 169 && octets[1] == 254 { return true }
        return octets[0] == 100 && (64...127).contains(octets[1])
    }

    private func validatedPairing(_ url: URL) -> (target: URL, secret: String)? {
        guard url.scheme?.lowercased() == "sense", url.host?.lowercased() == "pair",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let targetValue = components.queryItems?.first(where: { $0.name == "url" })?.value,
              let rawSecret = components.queryItems?.first(where: { $0.name == "secret" })?.value,
              let target = URL(string: targetValue), isSafeBridgeURL(target)
        else { return nil }
        let secret = rawSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        return secret.utf8.count >= 32 ? (target, secret) : nil
    }

    private func load() {
        let legacyData = defaults.data(forKey: "checkIns")

        var saved: [CheckIn]?
        var loadedProtectedData = false
        var migratedLegacyData = false
        do {
            if let data = try checkInPersistence.load() {
                do {
                    saved = try decoder.decode([CheckIn].self, from: data)
                    loadedProtectedData = true
                } catch {
                    try? checkInPersistence.remove()
                }
            }
        } catch CheckInPersistenceError.exceedsLimit {
            try? checkInPersistence.remove()
        } catch CheckInPersistenceError.unsafeFile {
            try? checkInPersistence.remove()
        } catch {
            // Complete file protection can make the file unavailable while the device is locked.
        }

        if saved == nil,
           let legacyData,
           legacyData.count <= checkInPersistence.maximumBytes,
           let legacyCheckIns = try? decoder.decode([CheckIn].self, from: legacyData) {
            saved = legacyCheckIns
            migratedLegacyData = true
        }
        guard let saved else { return }

        let cutoff = now()
        let retained = Array(
            saved
                .filter { $0.expiresAt > cutoff }
                .sorted { $0.createdAt > $1.createdAt }
                .prefix(12)
        )
        checkIns = retained
        let protectedDataReady =
            migratedLegacyData || retained != saved
                ? persistCurrentCheckIns()
                : loadedProtectedData
        if protectedDataReady, legacyData != nil {
            defaults.removeObject(forKey: "checkIns")
        }
    }

    @discardableResult
    private func pruneExpiredCheckIns() -> Bool {
        let retained = checkIns.filter { $0.expiresAt > now() }
        guard retained != checkIns else { return false }
        checkIns = retained
        persistCurrentCheckIns()
        return true
    }

    private func persist() {
        if !pruneExpiredCheckIns() {
            persistCurrentCheckIns()
        }
    }

    @discardableResult
    private func persistCurrentCheckIns() -> Bool {
        var retained = Array(
            checkIns
                .sorted { $0.createdAt > $1.createdAt }
                .prefix(12)
        )
        while !retained.isEmpty {
            guard let data = try? encoder.encode(retained) else {
                retained.removeLast()
                continue
            }
            guard data.count <= checkInPersistence.maximumBytes else {
                retained.removeLast()
                continue
            }
            do {
                try checkInPersistence.save(data)
                if retained != checkIns { checkIns = retained }
                return true
            } catch {
                return false
            }
        }
        checkIns = []
        do {
            try checkInPersistence.remove()
            return true
        } catch {
            return false
        }
    }
}

protocol BridgeSecretStoring {
    func read() -> String?
    @discardableResult func save(_ secret: String) -> Bool
}

struct BridgeSecretStore: BridgeSecretStoring {
    private let service = "com.chrisdimarco.sense.iphone-bridge"
    private let account = "pairing-secret"

    func read() -> String? {
        var item: CFTypeRef?
        var query = baseQuery
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let secret = String(data: data, encoding: .utf8),
              !secret.isEmpty
        else { return nil }
        return secret
    }

    @discardableResult
    func save(_ secret: String) -> Bool {
        guard !secret.isEmpty, let data = secret.data(using: .utf8) else { return false }
        let update = [kSecValueData: data] as CFDictionary
        let status = SecItemUpdate(baseQuery as CFDictionary, update)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var addition = baseQuery
        addition[kSecValueData] = data
        addition[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(addition as CFDictionary, nil) == errSecSuccess
    }

    private var baseQuery: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
    }
}
