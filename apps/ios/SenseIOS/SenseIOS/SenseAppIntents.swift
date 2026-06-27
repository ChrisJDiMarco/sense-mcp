import AppIntents
import Foundation

struct StartSenseCheckInIntent: AppIntent {
    static var title: LocalizedStringResource = "Start Sense Check-In"
    static var description = IntentDescription("Open Sense directly into a voice check-in.")
    static var openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set(true, forKey: "LaunchCheckIn")
        return .result()
    }
}

struct SaveQuickStateIntent: AppIntent {
    static var title: LocalizedStringResource = "Save Quick Sense State"
    static var description = IntentDescription("Save a quick internal-state note for Sense.")
    static var openAppWhenRun = true

    @Parameter(title: "Feeling", default: "steady")
    var feeling: String

    @Parameter(title: "Note", default: "")
    var note: String

    @MainActor
    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set(true, forKey: "LaunchCheckIn")
        UserDefaults.standard.set(feeling, forKey: "ShortcutFeeling")
        UserDefaults.standard.set(note, forKey: "ShortcutNote")
        return .result()
    }
}

struct SenseShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartSenseCheckInIntent(),
            phrases: [
                "Talk to \(.applicationName)",
                "Start a \(.applicationName) check in",
                "\(.applicationName) how I feel"
            ],
            shortTitle: "Talk to Sense",
            systemImageName: "waveform.circle.fill"
        )

        AppShortcut(
            intent: SaveQuickStateIntent(),
            phrases: [
                "Save my \(.applicationName) state",
                "Tell \(.applicationName) how I feel"
            ],
            shortTitle: "Save State",
            systemImageName: "heart.text.square.fill"
        )
    }
}
