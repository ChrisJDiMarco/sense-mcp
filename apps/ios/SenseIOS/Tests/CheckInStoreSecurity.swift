import Foundation

@MainActor
@main
struct CheckInStoreSecurity {
    static func main() throws {
        let suite = "sense-security-test-\(UUID().uuidString)"
        guard let defaults = UserDefaults(suiteName: suite) else { throw TestError.defaults }
        defer { defaults.removePersistentDomain(forName: suite) }

        var now = Date(timeIntervalSince1970: 1_900_000_000)
        let expired = makeCheckIn(
            createdAt: now.addingTimeInterval(-7_200),
            expiresAt: now.addingTimeInterval(-1),
            note: "expired private note"
        )
        let active = makeCheckIn(
            createdAt: now.addingTimeInterval(-60),
            expiresAt: now.addingTimeInterval(3_600),
            note: "active private note"
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        defaults.set(try encoder.encode([expired, active]), forKey: "checkIns")

        let legacy = "legacy-secret-with-at-least-thirty-two-bytes"
        defaults.set(legacy, forKey: "bridgeTokenString")
        defaults.set("focused", forKey: "ShortcutFeeling")
        defaults.set("legacy shortcut note", forKey: "ShortcutNote")
        let secrets = MemorySecretStore()
        let persistence = MemoryCheckInPersistence()
        let store = CheckInStore(
            defaults: defaults,
            secretStore: secrets,
            checkInPersistence: persistence,
            shortcutDraftStore: MemoryShortcutDraftStore(),
            now: { now }
        )
        guard defaults.object(forKey: "bridgeTokenString") == nil,
              defaults.object(forKey: "checkIns") == nil,
              defaults.object(forKey: "ShortcutFeeling") == nil,
              defaults.object(forKey: "ShortcutNote") == nil,
              secrets.read() == legacy,
              store.bridgeTokenString.isEmpty,
              store.selectedFeeling == .focused,
              store.note == "legacy shortcut note",
              store.checkIns == [active],
              try decode(persistence.data) == [active]
        else { throw TestError.migration }

        let protectedDraftSuite = "sense-security-shortcut-draft-\(UUID().uuidString)"
        guard let protectedDraftDefaults = UserDefaults(suiteName: protectedDraftSuite) else {
            throw TestError.defaults
        }
        defer { protectedDraftDefaults.removePersistentDomain(forName: protectedDraftSuite) }
        let shortcutDrafts = MemoryShortcutDraftStore(
            draft: ShortcutDraft(feeling: "anxious", note: "protected shortcut note")
        )
        let protectedDraftConsumer = CheckInStore(
            defaults: protectedDraftDefaults,
            secretStore: MemorySecretStore(),
            checkInPersistence: MemoryCheckInPersistence(),
            shortcutDraftStore: shortcutDrafts,
            now: { now }
        )
        guard protectedDraftConsumer.selectedFeeling == .anxious,
              protectedDraftConsumer.note == "protected shortcut note",
              shortcutDrafts.draft == nil,
              shortcutDrafts.removeCount == 1,
              protectedDraftDefaults.object(forKey: "ShortcutFeeling") == nil,
              protectedDraftDefaults.object(forKey: "ShortcutNote") == nil
        else { throw TestError.shortcutDraft }

        let failedSuite = "sense-security-failed-migration-\(UUID().uuidString)"
        guard let failedDefaults = UserDefaults(suiteName: failedSuite) else {
            throw TestError.defaults
        }
        defer { failedDefaults.removePersistentDomain(forName: failedSuite) }
        let legacyData = try encoder.encode([active])
        failedDefaults.set(legacyData, forKey: "checkIns")
        let failingPersistence = MemoryCheckInPersistence(failSaves: true)
        let failedMigration = CheckInStore(
            defaults: failedDefaults,
            secretStore: MemorySecretStore(),
            checkInPersistence: failingPersistence,
            now: { now }
        )
        guard failedMigration.checkIns == [active],
              failedDefaults.data(forKey: "checkIns") == legacyData,
              failingPersistence.data == nil
        else { throw TestError.failedMigrationWasDestructive }

        let invalidSuite = "sense-security-invalid-migration-\(UUID().uuidString)"
        guard let invalidDefaults = UserDefaults(suiteName: invalidSuite) else {
            throw TestError.defaults
        }
        defer { invalidDefaults.removePersistentDomain(forName: invalidSuite) }
        let invalidLegacyData = Data("not-json".utf8)
        invalidDefaults.set(invalidLegacyData, forKey: "checkIns")
        _ = CheckInStore(
            defaults: invalidDefaults,
            secretStore: MemorySecretStore(),
            checkInPersistence: MemoryCheckInPersistence(),
            now: { now }
        )
        guard invalidDefaults.data(forKey: "checkIns") == invalidLegacyData else {
            throw TestError.failedMigrationWasDestructive
        }

        now = active.expiresAt
        guard store.activeCheckIn == nil,
              store.checkIns.isEmpty,
              persistence.data == nil,
              persistence.removeCount > 0
        else { throw TestError.expiryPruning }

        try verifyProtectedFilePersistence()
        try verifyProtectedShortcutDraftPersistence()

        guard store.bridgeURLString.isEmpty else { throw TestError.unpairedDefault }

        let nextSecret = "new-pairing-secret-with-at-least-32-bytes"
        var components = URLComponents()
        components.scheme = "sense"
        components.host = "pair"
        components.queryItems = [
            URLQueryItem(name: "url", value: "http://192.168.1.10:3778/api/iphone-context"),
            URLQueryItem(name: "secret", value: nextSecret),
        ]
        guard let pairingURL = components.url else { throw TestError.pairing }
        store.stagePairingLink(pairingURL)
        guard secrets.read() == legacy,
              store.pendingPairingHost == "192.168.1.10"
        else { throw TestError.pairing }
        store.confirmPendingPairing()
        guard secrets.read() == nextSecret,
              store.bridgeURLString == "http://192.168.1.10:3778/api/iphone-context",
              store.bridgeTokenString.isEmpty,
              store.bridgeStatus == .paired
        else { throw TestError.pairing }

        components.queryItems = [
            URLQueryItem(name: "url", value: "https://collector.example/api/iphone-context"),
            URLQueryItem(name: "secret", value: nextSecret),
        ]
        guard let remoteURL = components.url, !store.handlePairingLink(remoteURL) else {
            throw TestError.remoteTargetAccepted
        }
        print("keychain-migration-pairing-ok")
    }

    private static func makeCheckIn(createdAt: Date, expiresAt: Date, note: String) -> CheckIn {
        let health = IphoneSensorSnapshot.HealthContext(
            health_available: true,
            steps_today: 4_321,
            active_energy_kcal_today: 210,
            heart_rate_bpm: 72,
            resting_heart_rate_bpm: 61,
            sleep_minutes_last_24h: 430
        )
        let sensors = IphoneSensorSnapshot(
            generated_at: createdAt,
            device: nil,
            motion: nil,
            noise: nil,
            health: health
        )
        let payload = SenseContextPayload(
            generated_at: createdAt,
            expires_at: expiresAt,
            internal_state: .init(
                feeling: FeelingTag.steady.rawValue,
                energy: 0.6,
                stress: 0.3,
                focus: 0.7,
                confidence: "medium",
                note: note,
                context_mode: "manual",
                semantic_tags: ["private"]
            ),
            iphone_context: sensors,
            assistive_hint: "adapt_tone_to_current_internal_state",
            privacy: ["scope": "semantic_self_report"]
        )
        return CheckIn(
            createdAt: createdAt,
            expiresAt: expiresAt,
            feeling: .steady,
            energy: 0.6,
            stress: 0.3,
            focus: 0.7,
            note: note,
            payload: payload
        )
    }

    private static func decode(_ data: Data?) throws -> [CheckIn] {
        guard let data else { throw TestError.persistence }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([CheckIn].self, from: data)
    }

    private static func verifyProtectedFilePersistence() throws {
        guard ProtectedCheckInFileStore.writeOptions.contains(.atomic) else {
            throw TestError.protection
        }
        #if os(iOS)
        guard ProtectedCheckInFileStore.writeOptions.contains(.completeFileProtection),
              ProtectedCheckInFileStore.fileProtection == .complete
        else { throw TestError.protection }
        #else
        guard !ProtectedCheckInFileStore.writeOptions.contains(.completeFileProtection) else {
            throw TestError.protection
        }
        #endif

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("sense-protected-store-\(UUID().uuidString)", isDirectory: true)
        let file = directory.appendingPathComponent("check-ins.json")
        defer { try? FileManager.default.removeItem(at: directory) }
        let persistence = ProtectedCheckInFileStore(fileURL: file, maximumBytes: 1_024)
        let sample = Data("protected-check-in".utf8)
        try persistence.save(sample)
        guard try persistence.load() == sample else { throw TestError.persistence }
        #if os(iOS)
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard attributes[.protectionKey] as? FileProtectionType == .complete else {
            throw TestError.protection
        }
        #endif

        do {
            try persistence.save(Data(repeating: 0, count: 1_025))
            throw TestError.bounds
        } catch CheckInPersistenceError.exceedsLimit {
            guard try persistence.load() == sample else { throw TestError.atomicity }
        }
    }

    private static func verifyProtectedShortcutDraftPersistence() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("sense-protected-shortcut-\(UUID().uuidString)", isDirectory: true)
        let file = directory.appendingPathComponent("shortcut-draft.json")
        defer { try? FileManager.default.removeItem(at: directory) }
        let persistence = ProtectedCheckInFileStore(fileURL: file, maximumBytes: 1_024)
        let drafts = ProtectedShortcutDraftStore(persistence: persistence)
        let draft = ShortcutDraft(feeling: "focused", note: "private Action Button note")
        try drafts.save(draft)
        guard try drafts.load() == draft else { throw TestError.shortcutDraft }
        #if os(iOS)
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard attributes[.protectionKey] as? FileProtectionType == .complete else {
            throw TestError.protection
        }
        #endif

        do {
            try drafts.save(ShortcutDraft(feeling: "steady", note: String(repeating: "x", count: 2_048)))
            throw TestError.bounds
        } catch CheckInPersistenceError.exceedsLimit {
            guard try drafts.load() == draft else { throw TestError.atomicity }
        }
        try drafts.remove()
        guard !FileManager.default.fileExists(atPath: file.path) else {
            throw TestError.shortcutDraft
        }
    }

    enum TestError: Error {
        case defaults
        case migration
        case persistence
        case failedMigrationWasDestructive
        case shortcutDraft
        case expiryPruning
        case protection
        case bounds
        case atomicity
        case unpairedDefault
        case pairing
        case remoteTargetAccepted
    }
}

private final class MemorySecretStore: BridgeSecretStoring {
    private var value: String?

    func read() -> String? { value }

    func save(_ secret: String) -> Bool {
        value = secret
        return true
    }
}

private final class MemoryCheckInPersistence: CheckInPersisting {
    let maximumBytes: Int
    var data: Data?
    private(set) var removeCount = 0
    private let failSaves: Bool

    init(maximumBytes: Int = 256 * 1_024, data: Data? = nil, failSaves: Bool = false) {
        self.maximumBytes = maximumBytes
        self.data = data
        self.failSaves = failSaves
    }

    func load() throws -> Data? {
        guard let data else { return nil }
        guard data.count <= maximumBytes else { throw CheckInPersistenceError.exceedsLimit }
        return data
    }

    func save(_ data: Data) throws {
        if failSaves { throw MemoryPersistenceError.writeFailed }
        guard data.count <= maximumBytes else { throw CheckInPersistenceError.exceedsLimit }
        self.data = data
    }

    func remove() throws {
        data = nil
        removeCount += 1
    }
}

private final class MemoryShortcutDraftStore: ShortcutDraftStoring {
    var draft: ShortcutDraft?
    private(set) var removeCount = 0

    init(draft: ShortcutDraft? = nil) {
        self.draft = draft
    }

    func load() throws -> ShortcutDraft? { draft }

    func save(_ draft: ShortcutDraft) throws {
        self.draft = draft
    }

    func remove() throws {
        draft = nil
        removeCount += 1
    }
}

private enum MemoryPersistenceError: Error {
    case writeFailed
}
