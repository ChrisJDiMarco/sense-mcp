import AVFoundation
import Foundation
import Speech

@MainActor
final class SpeechRecorder: NSObject, ObservableObject {
    @Published var transcript = ""
    @Published var isRecording = false
    @Published var permissionMessage = "Ready"

    private let audioEngine = AVAudioEngine()
    private let speechRecognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?

    func requestPermissions() async {
        let speechStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }

        let microphoneAllowed = await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { allowed in
                continuation.resume(returning: allowed)
            }
        }

        if speechStatus == .authorized && microphoneAllowed {
            permissionMessage = "Voice ready"
        } else if speechStatus != .authorized {
            permissionMessage = "Speech permission needed"
        } else {
            permissionMessage = "Microphone permission needed"
        }
    }

    func toggleRecording() async {
        if isRecording {
            stop()
        } else {
            await start()
        }
    }

    func start() async {
        await requestPermissions()
        guard permissionMessage == "Voice ready" else { return }

        recognitionTask?.cancel()
        recognitionTask = nil

        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            permissionMessage = "Audio session failed"
            return
        }

        request = SFSpeechAudioBufferRecognitionRequest()
        guard let request else {
            permissionMessage = "Speech request failed"
            return
        }
        request.shouldReportPartialResults = true

        let inputNode = audioEngine.inputNode
        recognitionTask = speechRecognizer?.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                if let result {
                    self?.transcript = result.bestTranscription.formattedString
                }
                if error != nil || result?.isFinal == true {
                    self?.stop()
                }
            }
        }

        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
            isRecording = true
            permissionMessage = "Listening"
        } catch {
            permissionMessage = "Could not start microphone"
            stop()
        }
    }

    func stop() {
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
        request?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        request = nil
        isRecording = false
        if permissionMessage == "Listening" {
            permissionMessage = "Voice ready"
        }
    }
}
