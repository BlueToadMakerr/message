plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.quickmessage.chat"
    compileSdk = 35
    defaultConfig {
        applicationId = "app.quickmessage.chat"
        minSdk = 24
        targetSdk = 35
        // Every GitHub build gets a higher versionCode, so a new APK installs over the old one.
        val run = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull() ?: 0
        versionCode = 100 + run
        versionName = "1.0.$run"
    }
    // One fixed signing key for every build. Android only installs an update over an app signed with the SAME key; the CI's random
    // debug key is why updates used to fail with "conflicts with an existing package". Override with your own key through the QM_* variables
    // (the workflow fills them from the ANDROID_KEYSTORE_B64 / ANDROID_STORE_PASS / ANDROID_KEY_ALIAS / ANDROID_KEY_PASS secrets when they exist).
    signingConfigs {
        create("qm") {
            storeFile = System.getenv("QM_KEYSTORE")?.takeIf { it.isNotBlank() }?.let { file(it) } ?: file("quickmessage.jks")
            storePassword = System.getenv("QM_STORE_PASS")?.takeIf { it.isNotBlank() } ?: "quickmessage"
            keyAlias = System.getenv("QM_KEY_ALIAS")?.takeIf { it.isNotBlank() } ?: "quickmessage"
            keyPassword = System.getenv("QM_KEY_PASS")?.takeIf { it.isNotBlank() } ?: "quickmessage"
        }
    }
    buildTypes {
        debug { signingConfig = signingConfigs.getByName("qm") }
        release { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("qm") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}
dependencies {
    // No libraries needed: the app is a WebView around the website plus a little native code.
}
