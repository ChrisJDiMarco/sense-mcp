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
                    guard url.scheme?.lowercased() == "sense" else { return }
                    if url.host?.lowercased() == "pair" {
                        store.stagePairingLink(url)
                    } else if url.host?.lowercased() == "checkin" {
                        store.activateCheckInFromShortcut()
                    }
                }
        }
    }
}
