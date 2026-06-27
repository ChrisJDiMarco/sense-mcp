import SwiftUI
import UIKit

struct RootView: View {
    var body: some View {
        TabView {
            CheckInView()
                .tabItem {
                    Label("Check In", systemImage: "mic.circle.fill")
                }

            SignalsView()
                .tabItem {
                    Label("Signals", systemImage: "sensor.tag.radiowaves.forward")
                }

            SetupView()
                .tabItem {
                    Label("Setup", systemImage: "button.programmable")
                }

            LedgerView()
                .tabItem {
                    Label("Ledger", systemImage: "clock")
                }
        }
        .tint(.blue)
    }
}

struct CheckInView: View {
    @EnvironmentObject private var store: CheckInStore
    @EnvironmentObject private var sensors: IphoneSensorStore
    @StateObject private var recorder = SpeechRecorder()
    @State private var showingPayload = false
    @State private var selectedPreset: CheckInPreset?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NowCockpitCard(
                        status: store.bridgeStatus,
                        feeling: store.selectedFeeling,
                        energy: store.energy,
                        stress: store.stress,
                        focus: store.focus,
                        contextMode: store.contextMode,
                        semanticTags: store.semanticTags,
                        activeCheckIn: store.activeCheckIn,
                        latestSnapshot: sensors.latest,
                        enabledLabels: sensors.enabledLabels
                    )
                    .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                }

                Section("Presets") {
                    PresetStrip(selected: selectedPreset) { preset in
                        applyPreset(preset)
                    }
                }

                Section {
                    VoiceCheckInRow(
                        isRecording: recorder.isRecording,
                        status: recorder.permissionMessage
                    ) {
                        Task { await recorder.toggleRecording() }
                    }

                    noteEditor
                } header: {
                    Text("Check In")
                } footer: {
                    Text("Speech is transcribed on device when available. Audio is not stored by Sense.")
                }

                Section("State") {
                    Picker("Feeling", selection: feelingBinding) {
                        ForEach(FeelingTag.allCases) { feeling in
                            Label(feeling.label, systemImage: feeling.systemImage)
                                .tag(feeling)
                        }
                    }

                    SignalSlider(title: "Energy", value: energyBinding, systemImage: "bolt.fill")
                    SignalSlider(title: "Stress", value: stressBinding, systemImage: "waveform.path.ecg")
                    SignalSlider(title: "Focus", value: focusBinding, systemImage: "scope")
                }

                Section {
                    HStack {
                        Label("Included Signals", systemImage: "sensor.tag.radiowaves.forward")
                        Spacer()
                        Text(sensors.enabledLabels.isEmpty ? "None" : sensors.enabledLabels.joined(separator: ", "))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    if let latest = sensors.latest {
                        SensorSnapshotSummary(snapshot: latest)
                    }

                    Button {
                        Task { await sensors.refresh() }
                    } label: {
                        Label(sensors.isRefreshing ? "Refreshing..." : "Refresh iPhone Signals", systemImage: "arrow.clockwise")
                    }
                    .disabled(sensors.isRefreshing)
                } header: {
                    Text("iPhone Signals")
                } footer: {
                    Text("Selected signals refresh before sending. They are semantic summaries, not raw streams.")
                }

                Section {
                    Picker("Expires", selection: expiryBinding) {
                        ForEach(ExpiryPreset.allCases) { preset in
                            Text(preset.label).tag(preset)
                        }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Context Window")
                } footer: {
                    Text("Sense treats this as temporary context, not long-term memory.")
                }

                Section("Local Bridge") {
                    TextField("Bridge URL", text: $store.bridgeURLString)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()

                    TextField("Bridge Token", text: $store.bridgeTokenString)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    HStack {
                        Label("Status", systemImage: store.bridgeStatus.systemImage)
                        Spacer()
                        StatusPill(status: store.bridgeStatus)
                    }

                    if case .failed(let message) = store.bridgeStatus {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }

                Section {
                    Button {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        Task {
                            await sensors.refresh()
                            await store.createCheckIn(sensorSnapshot: sensors.latest)
                        }
                    } label: {
                        HStack {
                            Spacer()
                            if store.bridgeStatus == .sending || sensors.isRefreshing {
                                ProgressView()
                            } else {
                                Image(systemName: "paperplane.fill")
                            }
                            Text(store.bridgeStatus == .sending || sensors.isRefreshing ? "Sending..." : "Send to Sense")
                                .fontWeight(.semibold)
                            Spacer()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(store.bridgeStatus == .sending || sensors.isRefreshing)

                    Button {
                        showingPayload = true
                    } label: {
                        Label("Preview Context Payload", systemImage: "doc.text.magnifyingglass")
                    }

                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        store.resetDraft()
                        recorder.transcript = ""
                    } label: {
                        Label("Reset Draft", systemImage: "arrow.counterclockwise")
                    }
                    if let active = store.activeCheckIn {
                        ContextReceiptView(checkIn: active)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Sense")
            .navigationBarTitleDisplayMode(.large)
            .sheet(isPresented: $showingPayload) {
                PayloadPreviewView(payload: store.payloadJSON(store.previewPayload(sensorSnapshot: sensors.latest)))
            }
            .onAppear {
                syncShortcutDraft()
                if store.shouldStartListening {
                    store.shouldStartListening = false
                    Task { await recorder.start() }
                }
            }
            .onChange(of: recorder.transcript) { _, newValue in
                store.note = newValue
                markManual()
            }
            .onChange(of: store.shouldStartListening) { _, newValue in
                guard newValue else { return }
                store.shouldStartListening = false
                Task { await recorder.start() }
            }
        }
    }

    private var noteEditor: some View {
        ZStack(alignment: .topLeading) {
            if store.note.isEmpty {
                Text("What should Sense know about how you feel right now?")
                    .foregroundStyle(.tertiary)
                    .padding(.top, 9)
                    .padding(.leading, 5)
                    .allowsHitTesting(false)
            }

            TextEditor(text: noteBinding)
                .frame(minHeight: 128)
                .scrollContentBackground(.hidden)
        }
    }

    private func syncShortcutDraft() {
        let defaults = UserDefaults.standard
        if let shortcutFeeling = defaults.string(forKey: "ShortcutFeeling"),
           let feeling = FeelingTag(rawValue: shortcutFeeling.lowercased()) {
            store.selectedFeeling = feeling
            defaults.removeObject(forKey: "ShortcutFeeling")
        }
        if let shortcutNote = defaults.string(forKey: "ShortcutNote"), !shortcutNote.isEmpty {
            store.note = shortcutNote
            defaults.removeObject(forKey: "ShortcutNote")
        }
    }

    private func applyPreset(_ preset: CheckInPreset) {
        selectedPreset = preset
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        store.selectedFeeling = preset.feeling
        store.energy = preset.energy
        store.stress = preset.stress
        store.focus = preset.focus
        store.contextMode = preset.mode
        store.semanticTags = preset.tags
        store.expiry = preset.expiry
        store.note = preset.note
    }

    private func markManual() {
        guard selectedPreset != nil else { return }
        selectedPreset = nil
        store.contextMode = "manual"
        store.semanticTags = []
    }

    private var feelingBinding: Binding<FeelingTag> {
        Binding(
            get: { store.selectedFeeling },
            set: { store.selectedFeeling = $0; markManual() }
        )
    }

    private var energyBinding: Binding<Double> {
        Binding(get: { store.energy }, set: { store.energy = $0; markManual() })
    }

    private var stressBinding: Binding<Double> {
        Binding(get: { store.stress }, set: { store.stress = $0; markManual() })
    }

    private var focusBinding: Binding<Double> {
        Binding(get: { store.focus }, set: { store.focus = $0; markManual() })
    }

    private var expiryBinding: Binding<ExpiryPreset> {
        Binding(get: { store.expiry }, set: { store.expiry = $0; markManual() })
    }

    private var noteBinding: Binding<String> {
        Binding(get: { store.note }, set: { store.note = $0; markManual() })
    }
}

struct SignalsView: View {
    @EnvironmentObject private var sensors: IphoneSensorStore

    var body: some View {
        NavigationStack {
            List {
                Section {
                    SignalStatusCard(
                        enabledLabels: sensors.enabledLabels,
                        latest: sensors.latest,
                        statusMessage: sensors.statusMessage
                    )
                    .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                }

                Section {
                    Toggle(isOn: $sensors.includeDevice) {
                        Label("Device State", systemImage: "iphone")
                    }
                    Toggle(isOn: $sensors.includeMotion) {
                        Label("Motion and Steps", systemImage: "figure.walk")
                    }
                    Toggle(isOn: $sensors.includeNoise) {
                        Label("Noise Level", systemImage: "waveform")
                    }
                    Toggle(isOn: $sensors.includeHealth) {
                        Label("Health Summary", systemImage: "heart.text.square")
                    }
                } header: {
                    Text("Included in Payload")
                } footer: {
                    Text("Device state is local and lightweight. Motion, noise, and Health require iOS permissions and are summarized before they reach Sense.")
                }

                Section {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        Task { await sensors.refresh() }
                    } label: {
                        Label(sensors.isRefreshing ? "Refreshing..." : "Refresh Now", systemImage: "arrow.clockwise")
                    }
                    .disabled(sensors.isRefreshing)

                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        Task { await sensors.requestHealthAccess() }
                    } label: {
                        Label("Request Health Access", systemImage: "heart")
                    }
                }

                Section("Status") {
                    HStack {
                        Text("Last Result")
                        Spacer()
                        Text(sensors.statusMessage)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.trailing)
                    }

                    if let latest = sensors.latest {
                        SensorSnapshotSummary(snapshot: latest)
                    } else {
                        ContentUnavailableView("No Signal Snapshot", systemImage: "sensor.tag.radiowaves.forward", description: Text("Refresh to see what the iPhone can add to Sense."))
                            .frame(maxWidth: .infinity)
                            .listRowBackground(Color.clear)
                    }
                }

                Section("Privacy") {
                    PrivacyRow(systemImage: "mic.slash", title: "No Audio Retention", detail: "Noise level uses a short meter sample and deletes the temporary file.")
                    PrivacyRow(systemImage: "heart.text.square", title: "Health Summaries Only", detail: "Sense receives broad summaries like steps, energy, heart rate, and sleep minutes.")
                    PrivacyRow(systemImage: "timer", title: "Expires With Context", detail: "iPhone signals are sent inside the same expiring check-in payload.")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Signals")
            .onChange(of: sensors.includeDevice) { _, _ in sensors.persistPreferences() }
            .onChange(of: sensors.includeMotion) { _, _ in sensors.persistPreferences() }
            .onChange(of: sensors.includeNoise) { _, _ in sensors.persistPreferences() }
            .onChange(of: sensors.includeHealth) { _, _ in sensors.persistPreferences() }
        }
    }
}

struct SetupView: View {
    @EnvironmentObject private var store: CheckInStore

    private let githubURL = URL(string: "https://github.com/ChrisJDiMarco/sense-mcp")!
    private let installCommand = """
    git clone https://github.com/ChrisJDiMarco/sense-mcp.git
    cd sense-mcp
    npm install
    npm run build
    node dist/index.js settings --open
    """
    private let codexConfig = """
    [mcp_servers.sense]
    command = "node"
    args = ["/absolute/path/to/sense-mcp/dist/index.js"]
    startup_timeout_sec = 20
    """

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Install Sense MCP on Mac", systemImage: "desktopcomputer")
                            .font(.title3.weight(.semibold))

                        Text("This iPhone app is the companion. The MCP server runs on the Mac where Codex, Claude, or another AI client can use local context.")
                            .foregroundStyle(.secondary)

                        Link(destination: githubURL) {
                            Label("Open GitHub", systemImage: "arrow.up.right.square")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .padding(.top, 4)
                    }
                    .padding(.vertical, 6)
                }

                Section {
                    CopyableCodeBlock(title: "Build and Open Settings", text: installCommand)
                    CopyableCodeBlock(title: "Codex MCP Config", text: codexConfig)
                } header: {
                    Text("Mac Setup")
                } footer: {
                    Text("After editing MCP config, restart the AI client so it can load Sense.")
                }

                Section {
                    TextField("Bridge URL", text: $store.bridgeURLString)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()

                    HStack {
                        Label("Status", systemImage: store.bridgeStatus.systemImage)
                        Spacer()
                        StatusPill(status: store.bridgeStatus)
                    }

                    Button {
                        Task { await store.testBridgeConnection() }
                    } label: {
                        Label("Test Connection", systemImage: "checkmark.circle")
                    }
                    .disabled(store.bridgeStatus == .sending)

                    if case .failed(let message) = store.bridgeStatus {
                        Text(message)
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                } header: {
                    Text("Local Bridge")
                } footer: {
                    Text("The simulator can use 127.0.0.1. For a physical iPhone, run sense-mcp settings --lan --open on the Mac, then paste the LAN URL and token here.")
                }

                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Action Button Ready", systemImage: "button.programmable")
                            .font(.title3.weight(.semibold))

                        Text("Create a shortcut that runs Talk to Sense, then assign it to the iPhone Action Button.")
                            .foregroundStyle(.secondary)

                        Link(destination: URL(string: "shortcuts://")!) {
                            Label("Open Shortcuts", systemImage: "arrow.up.right.square")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .padding(.top, 4)
                    }
                    .padding(.vertical, 6)
                }

                Section("Action Button Setup") {
                    InstructionRow(number: 1, title: "Add the App Shortcut", detail: "In Shortcuts, search for Talk to Sense.")
                    InstructionRow(number: 2, title: "Assign Action Button", detail: "Open Settings, choose Action Button, then pick the Sense shortcut.")
                    InstructionRow(number: 3, title: "Press and Speak", detail: "The app opens ready to listen and turns your words into context.")
                    InstructionRow(number: 4, title: "Send to Sense", detail: "The payload posts to the local Sense MCP bridge on your Mac.")
                }

                Section("Privacy") {
                    PrivacyRow(systemImage: "waveform", title: "No Audio Retention", detail: "The app keeps text context, not microphone recordings.")
                    PrivacyRow(systemImage: "timer", title: "Expiring Context", detail: "Each check-in includes an expiration window.")
                    PrivacyRow(systemImage: "network", title: "Local Bridge", detail: "The default endpoint is local to your own machine.")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Setup")
        }
    }
}

struct LedgerView: View {
    @EnvironmentObject private var store: CheckInStore
    @State private var selectedPayload: String?

    var body: some View {
        NavigationStack {
            List {
                if let active = store.activeCheckIn {
                    Section("Active Context") {
                        Button {
                            selectedPayload = store.payloadJSON(active.payload)
                        } label: {
                            CheckInRow(checkIn: active)
                        }
                        .buttonStyle(.plain)
                    }
                }

                Section("Timeline") {
                    if store.checkIns.isEmpty {
                        ContentUnavailableView("No Check-Ins", systemImage: "heart.text.square", description: Text("Your recent Sense check-ins will appear here."))
                            .frame(maxWidth: .infinity)
                            .listRowBackground(Color.clear)
                    } else {
                        ForEach(store.checkIns) { checkIn in
                            Button {
                                selectedPayload = store.payloadJSON(checkIn.payload)
                            } label: {
                                TimelineCheckInRow(checkIn: checkIn)
                            }
                            .buttonStyle(.plain)
                            .swipeActions {
                                Button(role: .destructive) {
                                    store.delete(checkIn)
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Ledger")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        Task { await store.sendLatestAgain() }
                    } label: {
                        Image(systemName: "arrow.triangle.2.circlepath")
                    }
                    .accessibilityLabel("Send latest again")
                    .disabled(store.checkIns.isEmpty)
                }
            }
            .sheet(item: Binding(
                get: { selectedPayload.map(PayloadSelection.init(payload:)) },
                set: { selectedPayload = $0?.payload }
            )) { selection in
                PayloadPreviewView(payload: selection.payload)
            }
        }
    }
}

struct PayloadSelection: Identifiable {
    let id = UUID()
    let payload: String
}

enum CheckInPreset: CaseIterable, Equatable, Identifiable {
    case beforeMeeting
    case deepWork
    case stuck
    case lowEnergy
    case fastHandoff

    var id: Self { self }

    var title: String {
        switch self {
        case .beforeMeeting: return "Before Meeting"
        case .deepWork: return "Deep Work"
        case .stuck: return "I'm Stuck"
        case .lowEnergy: return "Low Energy"
        case .fastHandoff: return "Fast Handoff"
        }
    }

    var mode: String {
        switch self {
        case .beforeMeeting: return "before_meeting"
        case .deepWork: return "deep_work"
        case .stuck: return "stuck"
        case .lowEnergy: return "low_energy"
        case .fastHandoff: return "fast_handoff"
        }
    }

    var tags: [String] {
        switch self {
        case .beforeMeeting: return ["time_pressure", "concise", "prep"]
        case .deepWork: return ["deep_work", "protect_focus", "direct"]
        case .stuck: return ["blocked", "unblock", "next_step"]
        case .lowEnergy: return ["low_energy", "small_steps", "low_friction"]
        case .fastHandoff: return ["handoff", "summarize", "risks"]
        }
    }

    var detail: String {
        switch self {
        case .beforeMeeting: return "Concise, prep-aware"
        case .deepWork: return "Protect focus"
        case .stuck: return "Unblock me"
        case .lowEnergy: return "Smaller steps"
        case .fastHandoff: return "Summarize state"
        }
    }

    var systemImage: String {
        switch self {
        case .beforeMeeting: return "calendar.badge.clock"
        case .deepWork: return "scope"
        case .stuck: return "questionmark.diamond"
        case .lowEnergy: return "battery.25percent"
        case .fastHandoff: return "arrowshape.turn.up.right"
        }
    }

    var feeling: FeelingTag {
        switch self {
        case .beforeMeeting: return .steady
        case .deepWork: return .focused
        case .stuck: return .blocked
        case .lowEnergy: return .tired
        case .fastHandoff: return .scattered
        }
    }

    var energy: Double {
        switch self {
        case .beforeMeeting: return 0.58
        case .deepWork: return 0.74
        case .stuck: return 0.48
        case .lowEnergy: return 0.24
        case .fastHandoff: return 0.50
        }
    }

    var stress: Double {
        switch self {
        case .beforeMeeting: return 0.44
        case .deepWork: return 0.22
        case .stuck: return 0.68
        case .lowEnergy: return 0.36
        case .fastHandoff: return 0.52
        }
    }

    var focus: Double {
        switch self {
        case .beforeMeeting: return 0.56
        case .deepWork: return 0.90
        case .stuck: return 0.38
        case .lowEnergy: return 0.42
        case .fastHandoff: return 0.62
        }
    }

    var expiry: ExpiryPreset {
        switch self {
        case .beforeMeeting, .fastHandoff: return .thirtyMinutes
        case .deepWork, .stuck, .lowEnergy: return .twoHours
        }
    }

    var note: String {
        switch self {
        case .beforeMeeting:
            return "Meeting soon. Keep it concise, prep-aware, and actionable."
        case .deepWork:
            return "Deep work. Be direct and avoid optional detours."
        case .stuck:
            return "Stuck. Reduce scope and give me the next concrete move."
        case .lowEnergy:
            return "Low energy. Prefer small steps and low-friction progress."
        case .fastHandoff:
            return "Fast handoff. Capture state, risks, and the next action."
        }
    }
}

struct PresetStrip: View {
    let selected: CheckInPreset?
    let apply: (CheckInPreset) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(CheckInPreset.allCases) { preset in
                    let isSelected = selected == preset
                    Button {
                        apply(preset)
                    } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            Image(systemName: preset.systemImage)
                                .font(.headline)
                                .foregroundStyle(isSelected ? .white : .blue)
                            Text(preset.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(isSelected ? .white : .primary)
                            Text(preset.detail)
                                .font(.caption)
                                .foregroundStyle(isSelected ? .white.opacity(0.78) : .secondary)
                        }
                        .frame(width: 142, alignment: .leading)
                        .padding(12)
                        .background(isSelected ? Color.blue : Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .strokeBorder(isSelected ? Color.blue.opacity(0.45) : Color.clear)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 4)
        }
    }
}

struct NowCockpitCard: View {
    let status: BridgeStatus
    let feeling: FeelingTag
    let energy: Double
    let stress: Double
    let focus: Double
    let contextMode: String
    let semanticTags: [String]
    let activeCheckIn: CheckIn?
    let latestSnapshot: IphoneSensorSnapshot?
    let enabledLabels: [String]

    private var signalSummary: String {
        if latestSnapshot != nil {
            return enabledLabels.isEmpty ? "No signals included" : enabledLabels.joined(separator: ", ")
        }
        return enabledLabels.isEmpty ? "Signals off" : "Ready: \(enabledLabels.joined(separator: ", "))"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Now")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    Text(feeling.label)
                        .font(.system(.largeTitle, design: .rounded).weight(.bold))
                        .foregroundStyle(feeling.color)
                    Text(activeCheckIn?.note ?? "Share a quick state update before Sense answers.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer()

                StatusPill(status: status)
            }

            VStack(spacing: 10) {
                MetricBar(title: "Energy", value: energy, systemImage: "bolt.fill", tint: .green)
                MetricBar(title: "Stress", value: stress, systemImage: "waveform.path.ecg", tint: .orange)
                MetricBar(title: "Focus", value: focus, systemImage: "scope", tint: .blue)
            }

            VStack(spacing: 8) {
                CockpitFact(systemImage: "sensor.tag.radiowaves.forward", title: "Signals", detail: signalSummary)
                CockpitFact(systemImage: "target", title: "Mode", detail: contextMode.replacingOccurrences(of: "_", with: " "))
                CockpitFact(systemImage: "timer", title: "Expires", detail: activeCheckIn?.activeForLabel ?? "Not sent")
            }

            if let activeCheckIn {
                ExpiryProgressView(checkIn: activeCheckIn)
            }

            if !semanticTags.isEmpty {
                TagCloud(tags: semanticTags)
            }
        }
        .padding(18)
        .background(
            LinearGradient(
                colors: [Color(.secondarySystemGroupedBackground), feeling.color.opacity(0.14)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ),
            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(feeling.color.opacity(0.22))
        )
    }
}

struct MetricBar: View {
    let title: String
    let value: Double
    let systemImage: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(title, systemImage: systemImage)
                    .font(.caption.weight(.semibold))
                Spacer()
                Text(value.percentageLabel)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color(.tertiarySystemFill))
                    Capsule()
                        .fill(tint)
                        .frame(width: max(8, proxy.size.width * value))
                }
            }
            .frame(height: 7)
        }
    }
}

struct CockpitFact: View {
    let systemImage: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
                .foregroundStyle(.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct ContextReceiptView: View {
    let checkIn: CheckIn

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Context Receipt", systemImage: "checkmark.seal.fill")
                    .font(.headline)
                    .foregroundStyle(.green)
                Spacer()
                Text(checkIn.isExpired ? "Expired" : "Active")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(checkIn.isExpired ? Color.secondary : Color.green)
            }

            Text(checkIn.note)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(3)

            HStack(spacing: 12) {
                Label(checkIn.energy.percentageLabel, systemImage: "bolt.fill")
                Label(checkIn.stress.percentageLabel, systemImage: "waveform.path.ecg")
                Label(checkIn.focus.percentageLabel, systemImage: "scope")
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            if let receipt = checkIn.receipt {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Receipt \(receipt.compactID)", systemImage: "tray.full")
                        .font(.caption.weight(.semibold))
                    Text(receipt.acceptedSummary)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            } else {
                Label("Saved locally; not accepted by Mac yet", systemImage: "tray")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            if let tags = checkIn.payload.internal_state.semantic_tags, !tags.isEmpty {
                TagCloud(tags: tags)
            }

            ExpiryProgressView(checkIn: checkIn)
        }
        .padding(.vertical, 6)
    }
}

struct ExpiryProgressView: View {
    let checkIn: CheckIn

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(checkIn.activeForLabel)
                Spacer()
                Text(checkIn.expiresAt, style: .relative)
                    .monospacedDigit()
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            ProgressView(value: checkIn.expiryProgress)
                .tint(checkIn.isExpired ? .secondary : .green)
        }
    }
}

struct TagCloud: View {
    let tags: [String]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(tags, id: \.self) { tag in
                    Text(tag.replacingOccurrences(of: "_", with: " "))
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(Color.blue.opacity(0.10), in: Capsule())
                        .foregroundStyle(.blue)
                }
            }
        }
    }
}

struct CheckInSummaryCard: View {
    let status: BridgeStatus

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "heart.text.square.fill")
                    .font(.title2)
                    .foregroundStyle(.blue)
                    .frame(width: 34, height: 34)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Ready for Sense")
                        .font(.headline)
                    Text("Share how you are doing so Sense can adapt before it answers.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer()
                StatusPill(status: status)
            }
        }
        .padding(.vertical, 4)
    }
}

struct VoiceCheckInRow: View {
    let isRecording: Bool
    let status: String
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 14) {
                Button {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    action()
                } label: {
                    Image(systemName: isRecording ? "stop.fill" : "mic.fill")
                        .font(.title2.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(width: 64, height: 64)
                        .background(isRecording ? Color.red : Color.blue, in: Circle())
                        .shadow(color: (isRecording ? Color.red : Color.blue).opacity(0.28), radius: 16, y: 8)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(isRecording ? "Stop recording" : "Start recording")

                VStack(alignment: .leading, spacing: 4) {
                    Text(isRecording ? "Listening" : "Voice Check-In")
                        .font(.headline)
                    Text(status)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer()
            }

            if isRecording {
                Label("Recording on device", systemImage: "waveform")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.red)
            }
        }
        .padding(.vertical, 6)
    }
}

struct SignalSlider: View {
    let title: String
    @Binding var value: Double
    let systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(title, systemImage: systemImage)
                    .font(.headline)
                Spacer()
                Text(value.percentageLabel)
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }

            Slider(value: $value, in: 0...1)
                .tint(.blue)
        }
        .padding(.vertical, 4)
    }
}

struct SensorSnapshotSummary: View {
    let snapshot: IphoneSensorSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let device = snapshot.device {
                SignalSummaryRow(
                    systemImage: "battery.75percent",
                    title: "Device",
                    detail: [
                        device.battery_percent.map { "\(($0 * 100).roundedInt)%" },
                        device.power_state,
                        device.low_power_mode ? "Low Power" : nil,
                        "Thermal \(device.thermal_state)",
                    ].compactMap { $0 }.joined(separator: " · ")
                )
            }

            if let motion = snapshot.motion {
                SignalSummaryRow(
                    systemImage: "figure.walk",
                    title: "Motion",
                    detail: [
                        motion.activity_class,
                        motion.steps_today.map { "\($0) steps" },
                        motion.distance_meters_today.map { "\($0.roundedInt)m" },
                    ].compactMap { $0 }.joined(separator: " · ").emptyFallback("Unavailable")
                )
            }

            if let noise = snapshot.noise {
                SignalSummaryRow(
                    systemImage: "waveform",
                    title: "Noise",
                    detail: "\(noise.noise_class) · \(noise.average_dbfs.roundedInt) dBFS"
                )
            }

            if let health = snapshot.health {
                SignalSummaryRow(
                    systemImage: "heart.text.square",
                    title: "Health",
                    detail: [
                        health.steps_today.map { "\($0) steps" },
                        health.active_energy_kcal_today.map { "\($0.roundedInt) kcal" },
                        health.heart_rate_bpm.map { "\($0.roundedInt) bpm" },
                        health.sleep_minutes_last_24h.map { "\($0) min sleep" },
                    ].compactMap { $0 }.joined(separator: " · ").emptyFallback(health.health_available ? "No recent samples" : "Unavailable")
                )
            }
        }
        .padding(.vertical, 4)
    }
}

struct SignalStatusCard: View {
    let enabledLabels: [String]
    let latest: IphoneSensorSnapshot?
    let statusMessage: String

    private var enabledText: String {
        enabledLabels.isEmpty ? "None" : enabledLabels.joined(separator: ", ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Signals")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)
                    Text(enabledText)
                        .font(.system(.title2, design: .rounded).weight(.bold))
                    Text(statusMessage)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Image(systemName: "sensor.tag.radiowaves.forward")
                    .font(.title2)
                    .foregroundStyle(.blue)
                    .frame(width: 42, height: 42)
                    .background(Color.blue.opacity(0.12), in: Circle())
            }

            if let latest {
                HStack {
                    Label("Last refresh", systemImage: "clock")
                    Spacer()
                    Text(latest.generated_at, style: .relative)
                        .monospacedDigit()
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(18)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

struct SignalSummaryRow: View {
    let systemImage: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(.blue)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct TimelineCheckInRow: View {
    let checkIn: CheckIn

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 4) {
                Circle()
                    .fill(checkIn.isExpired ? Color.secondary : checkIn.feeling.color)
                    .frame(width: 10, height: 10)
                Rectangle()
                    .fill(Color(.separator))
                    .frame(width: 1, height: 72)
            }
            .padding(.top, 8)

            CheckInRow(checkIn: checkIn)
        }
    }
}

struct StatusPill: View {
    let status: BridgeStatus

    var body: some View {
        Text(status.label)
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(status.tint.opacity(0.14), in: Capsule())
            .foregroundStyle(status.tint)
    }
}

private extension Double {
    var roundedInt: Int {
        Int(rounded())
    }
}

private extension String {
    func emptyFallback(_ fallback: String) -> String {
        isEmpty ? fallback : self
    }
}

struct CheckInRow: View {
    let checkIn: CheckIn

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 10) {
                Image(systemName: checkIn.feeling.systemImage)
                    .foregroundStyle(.blue)
                    .frame(width: 22)

                Text(checkIn.receipt.map { "Receipt \($0.compactID)" } ?? "Local check-in")
                    .font(.headline)

                Spacer()

                Text(checkIn.activeForLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(checkIn.isExpired ? Color.secondary : Color.green)
            }

            HStack(spacing: 10) {
                Text(checkIn.feeling.label)
                    .font(.subheadline.weight(.semibold))
                if let mode = checkIn.payload.internal_state.context_mode {
                    Label(mode.replacingOccurrences(of: "_", with: " "), systemImage: "target")
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            Text(checkIn.note)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            if let tags = checkIn.payload.internal_state.semantic_tags, !tags.isEmpty {
                TagCloud(tags: tags)
            }

            ExpiryProgressView(checkIn: checkIn)

            HStack(spacing: 12) {
                Label(checkIn.energy.percentageLabel, systemImage: "bolt.fill")
                Label(checkIn.stress.percentageLabel, systemImage: "waveform.path.ecg")
                Label(checkIn.focus.percentageLabel, systemImage: "scope")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

struct InstructionRow: View {
    let number: Int
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(number)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.blue)
                .frame(width: 28, height: 28)
                .background(Color.blue.opacity(0.12), in: Circle())

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 3)
    }
}

struct CopyableCodeBlock: View {
    let title: String
    let text: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(title)
                    .font(.headline)
                Spacer()
                Button {
                    UIPasteboard.general.string = text
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }

            Text(text)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .padding(.vertical, 4)
    }
}

struct PrivacyRow: View {
    let systemImage: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .foregroundStyle(.blue)
                .frame(width: 26)

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 3)
    }
}

struct PayloadPreviewView: View {
    let payload: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(payload)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Payload")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        UIPasteboard.general.string = payload
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                }
            }
        }
    }
}

extension FeelingTag {
    var systemImage: String {
        switch self {
        case .steady: return "circle"
        case .anxious: return "exclamationmark.circle"
        case .excited: return "sparkles"
        case .tired: return "moon"
        case .scattered: return "arrow.triangle.branch"
        case .focused: return "scope"
        case .blocked: return "nosign"
        case .low: return "battery.25percent"
        }
    }
}

extension BridgeStatus {
    var systemImage: String {
        switch self {
        case .idle: return "circle"
        case .savedLocally: return "tray"
        case .sending: return "arrow.up.circle"
        case .connected: return "checkmark.circle.fill"
        case .sent: return "checkmark.circle.fill"
        case .receiptError: return "doc.text.magnifyingglass"
        case .rejected: return "xmark.octagon.fill"
        case .failed: return "exclamationmark.triangle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .idle: return .secondary
        case .savedLocally: return .blue
        case .sending: return .blue
        case .connected: return .green
        case .sent: return .green
        case .receiptError: return .orange
        case .rejected: return .red
        case .failed: return .orange
        }
    }
}

#Preview {
    RootView()
        .environmentObject(CheckInStore())
}
