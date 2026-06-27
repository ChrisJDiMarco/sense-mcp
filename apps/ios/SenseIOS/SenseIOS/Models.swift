import Foundation
import SwiftUI

enum FeelingTag: String, CaseIterable, Codable, Identifiable {
    case steady
    case anxious
    case excited
    case tired
    case scattered
    case focused
    case blocked
    case low

    var id: String { rawValue }

    var label: String {
        switch self {
        case .steady: return "Steady"
        case .anxious: return "Anxious"
        case .excited: return "Excited"
        case .tired: return "Tired"
        case .scattered: return "Scattered"
        case .focused: return "Focused"
        case .blocked: return "Blocked"
        case .low: return "Low"
        }
    }

    var color: Color {
        switch self {
        case .steady: return .teal
        case .anxious: return .orange
        case .excited: return .green
        case .tired: return .indigo
        case .scattered: return .yellow
        case .focused: return .cyan
        case .blocked: return .red
        case .low: return .blue
        }
    }
}

enum ExpiryPreset: String, CaseIterable, Codable, Identifiable {
    case thirtyMinutes
    case twoHours
    case today

    var id: String { rawValue }

    var label: String {
        switch self {
        case .thirtyMinutes: return "30m"
        case .twoHours: return "2h"
        case .today: return "Today"
        }
    }

    var minutes: Int {
        switch self {
        case .thirtyMinutes: return 30
        case .twoHours: return 120
        case .today: return 720
        }
    }
}

enum BridgeStatus: Equatable {
    case idle
    case savedLocally
    case sending
    case connected
    case sent
    case receiptError(String)
    case rejected(String)
    case failed(String)

    var label: String {
        switch self {
        case .idle: return "Ready"
        case .savedLocally: return "Saved locally"
        case .sending: return "Sending"
        case .connected: return "Bridge ready"
        case .sent: return "Accepted by Mac"
        case .receiptError: return "Saved locally, receipt mismatch"
        case .rejected: return "Saved locally, rejected"
        case .failed: return "Saved locally, Mac offline"
        }
    }
}

struct IphoneSensorSnapshot: Codable, Equatable {
    struct DeviceContext: Codable, Equatable {
        var battery_percent: Double?
        var power_state: String
        var low_power_mode: Bool
        var thermal_state: String
        var device_model: String
        var system_version: String
    }

    struct MotionContext: Codable, Equatable {
        var activity_class: String?
        var activity_confidence: String?
        var steps_today: Int?
        var distance_meters_today: Double?
        var floors_ascended_today: Int?
    }

    struct NoiseContext: Codable, Equatable {
        var noise_class: String
        var average_dbfs: Double
        var peak_dbfs: Double
        var sampled_seconds: Double
        var audio_retained: Bool
    }

    struct HealthContext: Codable, Equatable {
        var health_available: Bool
        var steps_today: Int?
        var active_energy_kcal_today: Double?
        var heart_rate_bpm: Double?
        var resting_heart_rate_bpm: Double?
        var sleep_minutes_last_24h: Int?
    }

    var generated_at: Date
    var device: DeviceContext?
    var motion: MotionContext?
    var noise: NoiseContext?
    var health: HealthContext?
}

struct SenseContextPayload: Codable, Equatable {
    struct InternalState: Codable, Equatable {
        var feeling: String
        var energy: Double
        var stress: Double
        var focus: Double
        var confidence: String
        var note: String
        var context_mode: String?
        var semantic_tags: [String]?
    }

    var type: String = "sense_ios_check_in"
    var generated_at: Date
    var expires_at: Date
    var source: String = "iphone_action_button"
    var internal_state: InternalState
    var iphone_context: IphoneSensorSnapshot?
    var assistive_hint: String
    var privacy: [String: String]
}

struct BridgeReceipt: Codable, Equatable {
    var ok: Bool
    var stored: Bool?
    var receipt_id: String?
    var accepted_at: String?
    var expires_at: String?
    var context_mode: String?
    var semantic_tags: [String]?
    var iphone_signals: [String]?
    var accepted_fields: [String]?
    var accepted_summary: String?
    var path: String?

    var compactID: String {
        guard let receipt_id else { return "local" }
        return String(receipt_id.prefix(8))
    }
}

struct CheckIn: Identifiable, Codable, Equatable {
    var id: UUID = UUID()
    var createdAt: Date = Date()
    var expiresAt: Date
    var feeling: FeelingTag
    var energy: Double
    var stress: Double
    var focus: Double
    var note: String
    var payload: SenseContextPayload
    var receipt: BridgeReceipt?

    var isExpired: Bool {
        Date() >= expiresAt
    }

    var expiryProgress: Double {
        let total = max(1, expiresAt.timeIntervalSince(createdAt))
        let remaining = max(0, expiresAt.timeIntervalSinceNow)
        return min(1, max(0, 1 - remaining / total))
    }

    var activeForLabel: String {
        let remaining = max(0, Int(expiresAt.timeIntervalSinceNow.rounded()))
        guard remaining > 0 else { return "Expired" }
        let hours = remaining / 3600
        let minutes = (remaining % 3600) / 60
        if hours > 0 { return "Active for \(hours)h \(minutes)m" }
        return "Active for \(max(1, minutes))m"
    }
}

extension BridgeReceipt {
    var acceptedSummary: String {
        if let accepted_summary, !accepted_summary.isEmpty { return accepted_summary }
        guard let accepted_fields, !accepted_fields.isEmpty else { return "Mac accepted semantic context." }
        let names = accepted_fields.map { field in
            field
                .replacingOccurrences(of: "iphone_", with: "")
                .replacingOccurrences(of: "_", with: " ")
        }
        return "Mac accepted: \(names.joined(separator: ", "))."
    }
}

extension Double {
    var percentageLabel: String {
        "\(Int((self * 100).rounded()))%"
    }
}
