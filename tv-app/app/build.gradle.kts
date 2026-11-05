import java.io.File

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Server address and API key come from the project's .env (never committed).
fun envValue(key: String): String {
    System.getenv(key)?.takeIf { it.isNotBlank() }?.let { return it }
    val f = File(rootDir.parentFile, ".env")
    if (!f.exists()) return ""
    return f.readLines(Charsets.UTF_8)
        .firstOrNull { it.startsWith("$key=") }
        ?.substringAfter("=")?.trim() ?: ""
}

android {
    namespace = "com.teletvshare.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.teletvshare.tv"
        minSdk = 21
        targetSdk = 35
        versionCode = 3
        versionName = "3.0"
        buildConfigField("String", "ARVAN_URL", "\"https://teletvshare-files.s3.ir-central1.arvanstorage.ir\"")
        buildConfigField("String", "BOT_USERNAME", "\"TeleTVShare_bot\"")
    }

    buildFeatures { buildConfig = true }

    // Fixed release key so new versions install over old ones (CI writes it from a secret).
    val ksFile = System.getenv("TV_KEYSTORE")?.let { file(it) }
    signingConfigs {
        if (ksFile != null && ksFile.exists()) {
            create("release") {
                storeFile = ksFile
                storePassword = System.getenv("TV_KEYSTORE_PASSWORD")
                keyAlias = "tv"
                keyPassword = System.getenv("TV_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.6")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("io.coil-kt:coil:2.7.0")
    implementation("com.google.zxing:core:3.5.3")
}
