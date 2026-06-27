import SwiftUI

@main
struct SenseIOSApp: App {
    @StateObject private var store = CheckInStore()
    @StateObject private var sensors = IphoneSensorStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(sensors)
                .onOpenURL { url in
                    guard url.scheme == "sense" else { return }
                    if url.host == "checkin" {
                        store.activateCheckInFromShortcut()
                    }
                }
        }
    }
}
