import AVFoundation
import CoreMotion
import Foundation
import HealthKit
import UIKit

@MainActor
final class IphoneSensorStore: ObservableObject {
    @Published var includeDevice = true
    @Published var includeMotion = false
    @Published var includeNoise = false
    @Published var includeHealth = false
    @Published var latest: IphoneSensorSnapshot?
    @Published var statusMessage = "Device state ready"
    @Published var isRefreshing = false

    private let activityManager = CMMotionActivityManager()
    private let pedometer = CMPedometer()
    private let healthStore = HKHealthStore()
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        includeDevice = defaults.object(forKey: "includeDevice") as? Bool ?? true
        includeMotion = defaults.bool(forKey: "includeMotion")
        includeNoise = defaults.bool(forKey: "includeNoise")
        includeHealth = defaults.bool(forKey: "includeHealth")
        UIDevice.current.isBatteryMonitoringEnabled = true
    }

    var enabledLabels: [String] {
        [
            includeDevice ? "device" : nil,
            includeMotion ? "motion" : nil,
            includeNoise ? "noise" : nil,
            includeHealth ? "health" : nil,
        ].compactMap { $0 }
    }

    func persistPreferences() {
        defaults.set(includeDevice, forKey: "includeDevice")
        defaults.set(includeMotion, forKey: "includeMotion")
        defaults.set(includeNoise, forKey: "includeNoise")
        defaults.set(includeHealth, forKey: "includeHealth")
    }

    func refresh() async {
        persistPreferences()
        isRefreshing = true
        defer { isRefreshing = false }

        var snapshot = IphoneSensorSnapshot(
            generated_at: Date(),
            device: nil,
            motion: nil,
            noise: nil,
            health: nil
        )

        if includeDevice {
            snapshot.device = sampleDevice()
        }
        if includeMotion {
            snapshot.motion = await sampleMotion()
        }
        if includeNoise {
            snapshot.noise = await sampleNoise()
        }
        if includeHealth {
            snapshot.health = await sampleHealth()
        }

        latest = snapshot
        let labels = enabledLabels.isEmpty ? "none" : enabledLabels.joined(separator: ", ")
        statusMessage = "Refreshed \(labels)"
    }

    func requestHealthAccess() async {
        includeHealth = true
        persistPreferences()
        guard HKHealthStore.isHealthDataAvailable() else {
            statusMessage = "Health data unavailable"
            return
        }

        do {
            try await healthStore.requestAuthorization(toShare: [], read: healthTypes())
            statusMessage = "Health access ready"
        } catch {
            statusMessage = "Health access failed"
        }
    }

    private func sampleDevice() -> IphoneSensorSnapshot.DeviceContext {
        let batteryLevel = UIDevice.current.batteryLevel
        let batteryPercent = batteryLevel >= 0 ? Double(batteryLevel) : nil
        return .init(
            battery_percent: batteryPercent,
            power_state: powerState(UIDevice.current.batteryState),
            low_power_mode: ProcessInfo.processInfo.isLowPowerModeEnabled,
            thermal_state: thermalState(ProcessInfo.processInfo.thermalState),
            device_model: UIDevice.current.model,
            system_version: UIDevice.current.systemVersion
        )
    }

    private func sampleMotion() async -> IphoneSensorSnapshot.MotionContext {
        async let activity = currentActivity()
        async let pedometerData = todayPedometerData()
        let resolvedActivity = await activity
        let resolvedPedometer = await pedometerData
        return .init(
            activity_class: resolvedActivity?.label,
            activity_confidence: resolvedActivity?.confidence,
            steps_today: resolvedPedometer?.steps,
            distance_meters_today: resolvedPedometer?.distanceMeters,
            floors_ascended_today: resolvedPedometer?.floorsAscended
        )
    }

    private func sampleNoise() async -> IphoneSensorSnapshot.NoiseContext? {
        let microphoneAllowed = await requestMicrophonePermission()
        guard microphoneAllowed else {
            statusMessage = "Microphone permission needed"
            return nil
        }

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("sense-noise-\(UUID().uuidString).caf")
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatAppleIMA4),
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.low.rawValue,
        ]

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)

            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.isMeteringEnabled = true
            recorder.record()
            try await Task.sleep(nanoseconds: 700_000_000)
            recorder.updateMeters()
            let average = Double(recorder.averagePower(forChannel: 0))
            let peak = Double(recorder.peakPower(forChannel: 0))
            recorder.stop()
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            try? FileManager.default.removeItem(at: url)
            return .init(
                noise_class: classifyNoise(average),
                average_dbfs: average,
                peak_dbfs: peak,
                sampled_seconds: 0.7,
                audio_retained: false
            )
        } catch {
            try? FileManager.default.removeItem(at: url)
            statusMessage = "Noise sample failed"
            return nil
        }
    }

    private func sampleHealth() async -> IphoneSensorSnapshot.HealthContext {
        guard HKHealthStore.isHealthDataAvailable() else {
            return .init(health_available: false)
        }

        do {
            try await healthStore.requestAuthorization(toShare: [], read: healthTypes())
        } catch {
            return .init(health_available: true)
        }

        async let steps = quantitySum(.stepCount, unit: .count(), since: startOfToday())
        async let activeEnergy = quantitySum(.activeEnergyBurned, unit: .kilocalorie(), since: startOfToday())
        async let heartRate = latestQuantity(.heartRate, unit: HKUnit.count().unitDivided(by: .minute()), since: Date().addingTimeInterval(-24 * 60 * 60))
        async let restingHeartRate = latestQuantity(.restingHeartRate, unit: HKUnit.count().unitDivided(by: .minute()), since: Date().addingTimeInterval(-7 * 24 * 60 * 60))
        async let sleepMinutes = sleepMinutesLast24Hours()

        return await .init(
            health_available: true,
            steps_today: steps.map { Int($0.rounded()) },
            active_energy_kcal_today: activeEnergy,
            heart_rate_bpm: heartRate,
            resting_heart_rate_bpm: restingHeartRate,
            sleep_minutes_last_24h: sleepMinutes
        )
    }

    private func currentActivity() async -> (label: String, confidence: String)? {
        guard CMMotionActivityManager.isActivityAvailable() else { return nil }
        let start = Date().addingTimeInterval(-5 * 60)
        return await withCheckedContinuation { continuation in
            activityManager.queryActivityStarting(from: start, to: Date(), to: .main) { activities, _ in
                guard let activity = activities?.last else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: (self.activityLabel(activity), self.activityConfidence(activity.confidence)))
            }
        }
    }

    private func todayPedometerData() async -> (steps: Int?, distanceMeters: Double?, floorsAscended: Int?)? {
        guard CMPedometer.isStepCountingAvailable() else { return nil }
        return await withCheckedContinuation { continuation in
            pedometer.queryPedometerData(from: startOfToday(), to: Date()) { data, _ in
                continuation.resume(
                    returning: data.map {
                        (
                            steps: $0.numberOfSteps.intValue,
                            distanceMeters: $0.distance?.doubleValue,
                            floorsAscended: $0.floorsAscended?.intValue
                        )
                    }
                )
            }
        }
    }

    private func quantitySum(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, since start: Date) async -> Double? {
        guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else { return nil }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
        return await withCheckedContinuation { continuation in
            let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, result, _ in
                continuation.resume(returning: result?.sumQuantity()?.doubleValue(for: unit))
            }
            healthStore.execute(query)
        }
    }

    private func latestQuantity(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, since start: Date) async -> Double? {
        guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else { return nil }
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: .strictStartDate)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
        return await withCheckedContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: 1, sortDescriptors: [sort]) { _, samples, _ in
                let quantity = (samples?.first as? HKQuantitySample)?.quantity.doubleValue(for: unit)
                continuation.resume(returning: quantity)
            }
            healthStore.execute(query)
        }
    }

    private func sleepMinutesLast24Hours() async -> Int? {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else { return nil }
        let start = Date().addingTimeInterval(-24 * 60 * 60)
        let predicate = HKQuery.predicateForSamples(withStart: start, end: Date(), options: [])
        return await withCheckedContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
                let seconds = (samples as? [HKCategorySample] ?? []).reduce(0.0) { total, sample in
                    guard sample.value == HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue ||
                            sample.value == HKCategoryValueSleepAnalysis.asleepCore.rawValue ||
                            sample.value == HKCategoryValueSleepAnalysis.asleepDeep.rawValue ||
                            sample.value == HKCategoryValueSleepAnalysis.asleepREM.rawValue
                    else { return total }
                    return total + sample.endDate.timeIntervalSince(sample.startDate)
                }
                continuation.resume(returning: seconds > 0 ? Int((seconds / 60).rounded()) : nil)
            }
            healthStore.execute(query)
        }
    }

    private func healthTypes() -> Set<HKObjectType> {
        var types = Set<HKObjectType>()
        [
            HKQuantityType.quantityType(forIdentifier: .stepCount),
            HKQuantityType.quantityType(forIdentifier: .activeEnergyBurned),
            HKQuantityType.quantityType(forIdentifier: .heartRate),
            HKQuantityType.quantityType(forIdentifier: .restingHeartRate),
        ].compactMap { $0 }.forEach { types.insert($0) }
        if let sleep = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            types.insert(sleep)
        }
        return types
    }

    private func requestMicrophonePermission() async -> Bool {
        return await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { allowed in
                continuation.resume(returning: allowed)
            }
        }
    }

    private func startOfToday() -> Date {
        Calendar.current.startOfDay(for: Date())
    }

    private func powerState(_ state: UIDevice.BatteryState) -> String {
        switch state {
        case .unknown: return "unknown"
        case .unplugged: return "battery"
        case .charging: return "charging"
        case .full: return "full"
        @unknown default: return "unknown"
        }
    }

    private func thermalState(_ state: ProcessInfo.ThermalState) -> String {
        switch state {
        case .nominal: return "nominal"
        case .fair: return "fair"
        case .serious: return "serious"
        case .critical: return "critical"
        @unknown default: return "unknown"
        }
    }

    private func activityLabel(_ activity: CMMotionActivity) -> String {
        if activity.automotive { return "in_vehicle" }
        if activity.cycling { return "cycling" }
        if activity.running { return "running" }
        if activity.walking { return "walking" }
        if activity.stationary { return "stationary" }
        return "unknown"
    }

    private func activityConfidence(_ confidence: CMMotionActivityConfidence) -> String {
        switch confidence {
        case .low: return "low"
        case .medium: return "medium"
        case .high: return "high"
        @unknown default: return "unknown"
        }
    }

    private func classifyNoise(_ dbfs: Double) -> String {
        if dbfs <= -55 { return "quiet" }
        if dbfs <= -42 { return "moderate" }
        if dbfs <= -30 { return "loud" }
        return "very_loud"
    }
}
