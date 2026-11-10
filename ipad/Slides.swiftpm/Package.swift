// swift-tools-version: 5.9

// Swift Playgrounds app package. Open this folder in Swift Playgrounds on an
// iPad (or in Xcode on a Mac) to build and run the app. Swift Playgrounds may
// rewrite this file when you change app settings in its UI; that is expected.

import PackageDescription
import AppleProductTypes

let package = Package(
    name: "Slides",
    platforms: [
        .iOS("17.0")
    ],
    products: [
        .iOSApplication(
            name: "Slides",
            targets: ["AppModule"],
            bundleIdentifier: "com.example.slides",
            displayVersion: "0.1",
            bundleVersion: "1",
            appIcon: .placeholder(icon: .pencil),
            accentColor: .presetColor(.orange),
            supportedDeviceFamilies: [
                .pad
            ],
            supportedInterfaceOrientations: [
                .portrait,
                .landscapeRight,
                .landscapeLeft,
                .portraitUpsideDown(.when(deviceFamilies: [.pad]))
            ]
        )
    ],
    targets: [
        .executableTarget(
            name: "AppModule",
            path: "."
        )
    ]
)
